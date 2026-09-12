//! Strict ZIP32 preflight precedes every filesystem write. ZIP64, encrypted,
//! multi-disk, ambiguous headers and unsupported compression are intentionally
//! excluded from the small prebuilt-package format.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use super::{
    MAX_ARCHIVE_BYTES, MAX_EXTRACTED_BYTES, MAX_PACKAGE_FILES, RECEIPT, Result, error, io_error,
};

fn invalid(message: impl Into<String>) -> super::GitHubDistributionError {
    error("github_zip_invalid", message)
}

pub(super) fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 240 || !name.is_ascii() || name.split('/').count() > 16 {
        return Err(invalid(
            "ZIP paths must be short, portable ASCII relative paths.",
        ));
    }
    for part in name.split('/') {
        let base = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let device = matches!(
            base.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit());
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.starts_with(' ')
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-@+ ".contains(&b))
            || device
            || part.eq_ignore_ascii_case(RECEIPT)
        {
            return Err(invalid(
                "ZIP contains a traversal, Windows alias, reserved receipt or non-portable path.",
            ));
        }
    }
    Ok(())
}

struct Entry {
    name: String,
    size: u64,
    compressed_size: u64,
    local_offset: usize,
    data_end: usize,
    directory: bool,
}

fn bytes_at(bytes: &[u8], offset: usize, len: usize) -> Result<&[u8]> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| invalid("ZIP offset overflow."))?;
    bytes
        .get(offset..end)
        .ok_or_else(|| invalid("Truncated ZIP header or data."))
}
fn word(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes_at(bytes, offset, 2)?.try_into().unwrap(),
    ))
}
fn dword(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes_at(bytes, offset, 4)?.try_into().unwrap(),
    ))
}
fn check_extra(bytes: &[u8]) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let kind = word(bytes, offset)?;
        let len = word(bytes, offset + 2)? as usize;
        bytes_at(bytes, offset + 4, len)?;
        if kind == 1 {
            return Err(invalid("ZIP64 packages are not supported."));
        }
        offset += 4 + len;
    }
    Ok(())
}

fn preflight(bytes: &[u8]) -> Result<Vec<Entry>> {
    if bytes.len() < 22 || bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(invalid("ZIP is empty, truncated or exceeds 32 MiB."));
    }
    let end = (bytes.len().saturating_sub(65557)..=bytes.len() - 22)
        .rev()
        .find(|&i| {
            bytes.get(i..i + 4) == Some(b"PK\x05\x06")
                && word(bytes, i + 20).is_ok_and(|n| i + 22 + n as usize == bytes.len())
        })
        .ok_or_else(|| invalid("ZIP end record is missing or has trailing data."))?;
    let count = word(bytes, end + 10)? as usize;
    let central_size = dword(bytes, end + 12)? as usize;
    let central_start = dword(bytes, end + 16)? as usize;
    if word(bytes, end + 4)? != 0
        || word(bytes, end + 6)? != 0
        || word(bytes, end + 8)? as usize != count
        || count == 0
        || count > MAX_PACKAGE_FILES
        || central_start.checked_add(central_size) != Some(end)
    {
        return Err(invalid(
            "ZIP must be a single-disk ZIP32 with at most 2048 entries.",
        ));
    }
    let mut cursor = central_start;
    let mut entries = Vec::with_capacity(count);
    let mut nodes: BTreeMap<String, (String, bool)> = BTreeMap::new();
    let mut explicit = BTreeSet::new();
    let mut total_size = 0u64;
    for _ in 0..count {
        if dword(bytes, cursor)? != 0x02014b50 {
            return Err(invalid("Invalid ZIP central-directory header."));
        }
        let flags = word(bytes, cursor + 8)?;
        let method = word(bytes, cursor + 10)?;
        let crc = dword(bytes, cursor + 16)?;
        let compressed_size = dword(bytes, cursor + 20)? as usize;
        let size = dword(bytes, cursor + 24)? as u64;
        let name_len = word(bytes, cursor + 28)? as usize;
        let extra_len = word(bytes, cursor + 30)? as usize;
        let comment_len = word(bytes, cursor + 32)? as usize;
        let attributes = dword(bytes, cursor + 38)?;
        let local_offset = dword(bytes, cursor + 42)? as usize;
        if flags & !0x080e != 0
            || !matches!(method, 0 | 8)
            || (method == 0 && flags & 6 != 0)
            || word(bytes, cursor + 34)? != 0
            || attributes & 0x400 != 0
        {
            return Err(invalid(
                "Encrypted, split, reparse or unsupported ZIP entries are forbidden.",
            ));
        }
        let raw_name = bytes_at(bytes, cursor + 46, name_len)?;
        let full_name =
            std::str::from_utf8(raw_name).map_err(|_| invalid("ZIP path is not UTF-8."))?;
        let directory = full_name.ends_with('/');
        let name = full_name.strip_suffix('/').unwrap_or(full_name);
        validate_name(name)?;
        let kind = (attributes >> 16) & 0xf000;
        if !matches!(kind, 0 | 0x4000 | 0x8000)
            || (kind == 0x4000 && !directory)
            || (kind == 0x8000 && directory)
            || (directory && (size != 0 || compressed_size != 0))
        {
            return Err(invalid(
                "ZIP symlinks, special files and inconsistent directories are forbidden.",
            ));
        }
        if !explicit.insert(name.to_ascii_lowercase()) {
            return Err(invalid("ZIP has duplicate or case-colliding paths."));
        }
        let parts: Vec<_> = name.split('/').collect();
        for i in 1..=parts.len() {
            let path = parts[..i].join("/");
            let is_directory = i < parts.len() || directory;
            let key = path.to_ascii_lowercase();
            if let Some((spelling, was_directory)) = nodes.get(&key) {
                if spelling != &path || *was_directory != is_directory {
                    return Err(invalid(
                        "ZIP paths have conflicting spelling or file/directory types.",
                    ));
                }
            } else {
                nodes.insert(key, (path, is_directory));
            }
        }
        if nodes.len() > MAX_PACKAGE_FILES {
            return Err(invalid("ZIP has too many implicit or explicit entries."));
        }
        total_size = total_size
            .checked_add(size)
            .ok_or_else(|| invalid("ZIP size overflow."))?;
        if total_size > MAX_EXTRACTED_BYTES {
            return Err(error("github_zip_limit", "ZIP would expand beyond 64 MiB."));
        }
        let extra = bytes_at(bytes, cursor + 46 + name_len, extra_len)?;
        check_extra(extra)?;
        cursor += 46 + name_len + extra_len + comment_len;
        if cursor > end {
            return Err(invalid(
                "ZIP central directory exceeds its declared bounds.",
            ));
        }
        if dword(bytes, local_offset)? != 0x04034b50
            || word(bytes, local_offset + 6)? != flags
            || word(bytes, local_offset + 8)? != method
            || word(bytes, local_offset + 26)? as usize != name_len
        {
            return Err(invalid("ZIP local and central headers disagree."));
        }
        let local_extra_len = word(bytes, local_offset + 28)? as usize;
        if bytes_at(bytes, local_offset + 30, name_len)? != raw_name {
            return Err(invalid("ZIP local and central paths disagree."));
        }
        check_extra(bytes_at(
            bytes,
            local_offset + 30 + name_len,
            local_extra_len,
        )?)?;
        let mut data_end = local_offset
            .checked_add(30 + name_len + local_extra_len)
            .and_then(|n| n.checked_add(compressed_size))
            .ok_or_else(|| invalid("ZIP file offset overflow."))?;
        if flags & 8 == 0 {
            if dword(bytes, local_offset + 14)? != crc
                || dword(bytes, local_offset + 18)? as usize != compressed_size
                || dword(bytes, local_offset + 22)? as u64 != size
            {
                return Err(invalid("ZIP local and central sizes/checksums disagree."));
            }
        } else {
            for (offset, expected) in [(14, crc), (18, compressed_size as u32), (22, size as u32)] {
                let actual = dword(bytes, local_offset + offset)?;
                if actual != 0 && actual != expected {
                    return Err(invalid(
                        "ZIP descriptor header disagrees with central directory.",
                    ));
                }
            }
            if dword(bytes, data_end)? == 0x08074b50 {
                data_end += 4;
            }
            if dword(bytes, data_end)? != crc
                || dword(bytes, data_end + 4)? as usize != compressed_size
                || dword(bytes, data_end + 8)? as u64 != size
            {
                return Err(invalid(
                    "ZIP data descriptor disagrees with central directory.",
                ));
            }
            data_end += 12;
        }
        if data_end > central_start {
            return Err(invalid("ZIP data overlaps its central directory."));
        }
        entries.push(Entry {
            name: full_name.into(),
            size,
            compressed_size: compressed_size as u64,
            local_offset,
            data_end,
            directory,
        });
    }
    if cursor != end {
        return Err(invalid("ZIP central-directory count/size mismatch."));
    }
    let mut ranges: Vec<_> = entries
        .iter()
        .map(|e| (e.local_offset, e.data_end))
        .collect();
    ranges.sort_unstable();
    let mut next = 0;
    for (start, end) in ranges {
        if start != next {
            return Err(invalid(
                "ZIP has overlapping files, hidden data or a self-extracting prefix.",
            ));
        }
        next = end;
    }
    if next != central_start {
        return Err(invalid(
            "ZIP contains unaccounted data before its central directory.",
        ));
    }
    if !entries
        .iter()
        .any(|e| e.name == "codlet.json" && !e.directory)
    {
        return Err(error(
            "github_package_manifest_missing",
            "ZIP root must contain codlet.json and prebuilt JavaScript entries.",
        ));
    }
    Ok(entries)
}

pub(super) fn extract(bytes: &[u8], destination: &Path) -> Result<()> {
    let entries = preflight(bytes)?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| invalid(e.to_string()))?;
    if archive.len() != entries.len()
        || archive.offset() != 0
        || archive
            .has_overlapping_files()
            .map_err(|e| invalid(e.to_string()))?
    {
        return Err(invalid("ZIP decoder found an ambiguous archive."));
    }
    let mut total = 0u64;
    for (index, expected) in entries.iter().enumerate() {
        let mut input = archive
            .by_index(index)
            .map_err(|e| invalid(e.to_string()))?;
        if input.name_raw() != expected.name.as_bytes()
            || input.name() != expected.name
            || input.size() != expected.size
            || input.compressed_size() != expected.compressed_size
            || input.is_symlink()
            || input.encrypted()
        {
            return Err(invalid("ZIP decoder and checked headers disagree."));
        }
        let output = destination.join(expected.name.trim_end_matches('/'));
        if expected.directory {
            std::fs::create_dir_all(&output).map_err(io_error)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(io_error)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(io_error)?;
        let mut actual = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = input
                .read(&mut buffer)
                .map_err(|e| invalid(format!("Invalid ZIP file data or CRC: {e}")))?;
            if n == 0 {
                break;
            }
            actual += n as u64;
            total += n as u64;
            if actual > expected.size || total > MAX_EXTRACTED_BYTES {
                return Err(error(
                    "github_zip_limit",
                    "ZIP expanded beyond its declared size or byte limit.",
                ));
            }
            file.write_all(&buffer[..n]).map_err(io_error)?;
        }
        if actual != expected.size {
            return Err(invalid("ZIP decompressed size does not match its header."));
        }
        file.sync_all().map_err(io_error)?;
    }
    Ok(())
}
