//! Poll bounded stdin input. No blocking reader thread survives Host completion.
use crate::plugin_control::{PluginControlAction, PluginControlRequest};
use std::io;
use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_TYPE_CHAR, FILE_TYPE_DISK, FILE_TYPE_PIPE, GetFileType, ReadFile,
};
use windows_sys::Win32::System::Console::{
    GetNumberOfConsoleInputEvents, GetStdHandle, INPUT_RECORD, KEY_EVENT, ReadConsoleInputW,
    STD_INPUT_HANDLE,
};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

pub(super) enum InputEvent {
    Start,
    Quit,
    Plugin(PluginControlRequest),
    Invalid,
    Eof,
    Error(String),
}
pub(super) struct ControlInput {
    handle: HANDLE,
    kind: u32,
    line: Vec<u8>,
    oversized: bool,
    ended: bool,
    pending: Vec<InputEvent>,
}

impl ControlInput {
    #[cfg(test)]
    pub(super) fn scripted(events: Vec<InputEvent>) -> Self {
        Self {
            handle: std::ptr::null_mut(),
            kind: 0,
            line: Vec::new(),
            oversized: false,
            ended: true,
            pending: events,
        }
    }
    pub(super) fn new() -> Self {
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let valid = !handle.is_null() && handle != INVALID_HANDLE_VALUE;
        let kind = if valid {
            unsafe { GetFileType(handle) }
        } else {
            0
        };
        Self {
            handle,
            kind,
            line: Vec::new(),
            oversized: false,
            ended: !valid,
            pending: Vec::new(),
        }
    }

    pub(super) fn poll(&mut self) -> Vec<InputEvent> {
        if !self.pending.is_empty() {
            return std::mem::take(&mut self.pending);
        }
        if self.ended {
            return Vec::new();
        }
        match self.poll_inner() {
            Ok(events) => events,
            Err(error) => {
                self.ended = true;
                vec![InputEvent::Error(error.to_string())]
            }
        }
    }

    pub(super) fn defer(&mut self, events: Vec<InputEvent>) {
        self.pending = events;
    }

    pub(super) fn is_open(&self) -> bool {
        !self.ended
    }

    fn poll_inner(&mut self) -> io::Result<Vec<InputEvent>> {
        let mut events = Vec::new();
        if self.kind == FILE_TYPE_CHAR {
            let mut available = 0;
            if unsafe { GetNumberOfConsoleInputEvents(self.handle, &mut available) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if available == 0 {
                return Ok(events);
            }
            let mut records: [INPUT_RECORD; 32] = unsafe { std::mem::zeroed() };
            let mut read = 0;
            if unsafe {
                ReadConsoleInputW(
                    self.handle,
                    records.as_mut_ptr(),
                    available.min(32),
                    &mut read,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            for record in &records[..read as usize] {
                if record.EventType == KEY_EVENT as u16 {
                    let key = unsafe { record.Event.KeyEvent };
                    if key.bKeyDown != 0 {
                        let character = unsafe { key.uChar.UnicodeChar };
                        for _ in 0..key.wRepeatCount.min(128) {
                            match character {
                                0 => {}
                                8 => {
                                    self.line.pop();
                                }
                                13 => self.byte(b'\n', &mut events),
                                1..=127 => self.byte(character as u8, &mut events),
                                _ => self.oversized = true,
                            }
                        }
                    }
                }
            }
        } else if self.kind == FILE_TYPE_PIPE || self.kind == FILE_TYPE_DISK {
            let mut available = 256;
            if self.kind == FILE_TYPE_PIPE
                && unsafe {
                    PeekNamedPipe(
                        self.handle,
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null_mut(),
                        &mut available,
                        std::ptr::null_mut(),
                    )
                } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    self.ended = true;
                    events.push(InputEvent::Eof);
                    return Ok(events);
                }
                return Err(error);
            }
            if available == 0 {
                return Ok(events);
            }
            let mut bytes = [0_u8; 256];
            let mut read = 0;
            if unsafe {
                ReadFile(
                    self.handle,
                    bytes.as_mut_ptr(),
                    available.min(256),
                    &mut read,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if read == 0 {
                self.ended = true;
                events.push(InputEvent::Eof);
            }
            for byte in &bytes[..read as usize] {
                self.byte(*byte, &mut events);
            }
        } else {
            self.ended = true;
            events.push(InputEvent::Eof);
        }
        Ok(events)
    }

    fn byte(&mut self, byte: u8, events: &mut Vec<InputEvent>) {
        if byte == b'\n' {
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            events.push(match (self.oversized, self.line.as_slice()) {
                (false, b"start") => InputEvent::Start,
                (false, b"quit") => InputEvent::Quit,
                (false, line) => {
                    parse_plugin_command(line).map_or(InputEvent::Invalid, InputEvent::Plugin)
                }
                _ => InputEvent::Invalid,
            });
            self.line.clear();
            self.oversized = false;
        } else if self.line.len() < 256 {
            self.line.push(byte);
        } else {
            self.oversized = true;
        }
    }
}

fn parse_plugin_command(line: &[u8]) -> Option<PluginControlRequest> {
    let line = std::str::from_utf8(line).ok()?;
    let parts: Vec<_> = line.split(' ').collect();
    let ["plugin", action, plugin_id] = parts.as_slice() else {
        return None;
    };
    let action = match *action {
        "enable" => PluginControlAction::Enable,
        "disable" => PluginControlAction::Disable,
        "reload" => PluginControlAction::Reload,
        _ => return None,
    };
    let request = PluginControlRequest {
        action,
        plugin_id: crate::plugins::canonical_plugin_id(plugin_id).to_owned(),
    };
    request.validate().ok()?;
    Some(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_parser_accepts_only_complete_fixed_quit_and_bounds_input() {
        let mut input = ControlInput {
            handle: std::ptr::null_mut(),
            kind: 0,
            line: Vec::new(),
            oversized: false,
            ended: false,
            pending: Vec::new(),
        };
        let mut events = Vec::new();
        for byte in b"start\nquit\r\neval 1+1\nquit --force\n" {
            input.byte(*byte, &mut events);
        }
        assert!(matches!(
            events.as_slice(),
            [
                InputEvent::Start,
                InputEvent::Quit,
                InputEvent::Invalid,
                InputEvent::Invalid
            ]
        ));
        events.clear();
        for _ in 0..4096 {
            input.byte(b'x', &mut events);
        }
        assert_eq!(input.line.len(), 256);
        input.byte(b'\n', &mut events);
        assert!(matches!(events.as_slice(), [InputEvent::Invalid]));
        assert!(input.line.is_empty());
    }

    #[test]
    fn plugin_commands_accept_fixed_actions_and_ids_without_paths_or_extra_arguments() {
        for (line, action) in [
            ("plugin enable codlet", PluginControlAction::Enable),
            ("plugin disable codlet", PluginControlAction::Disable),
            (
                "plugin reload codex.ui.adapter",
                PluginControlAction::Reload,
            ),
        ] {
            assert_eq!(
                parse_plugin_command(line.as_bytes()).unwrap().action,
                action
            );
        }
        for line in [
            "plugin reload",
            "plugin reload codlet --force",
            "plugin reload C:/plugin",
            "plugin eval codlet",
            "plugin reload ../codlet",
            "plugin reload codlet\0",
            "plugin  reload codlet",
            "plugin reload Codlet",
            "plugin reload codlet ",
        ] {
            assert!(parse_plugin_command(line.as_bytes()).is_none(), "{line:?}");
        }
    }
}
