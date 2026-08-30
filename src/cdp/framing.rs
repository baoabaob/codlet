use std::io::{self, Write};

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

pub const MAX_CDP_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum FramingError {
    #[error("CDP pipe contained an empty NUL-delimited frame")]
    EmptyFrame,
    #[error("CDP pipe ended with {buffered_bytes} unterminated bytes")]
    TruncatedFrame { buffered_bytes: usize },
    #[error("CDP frame is not valid JSON: {message}")]
    InvalidJson { message: String },
    #[error("CDP frame exceeds the {max_bytes}-byte limit")]
    FrameTooLarge { max_bytes: usize },
    #[error("failed to write CDP frame: {message}")]
    Write { message: String },
}

#[derive(Debug, Default)]
pub struct NulJsonDecoder {
    buffer: Vec<u8>,
}

impl NulJsonDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, FramingError> {
        let mut messages = Vec::new();

        for &byte in chunk {
            if byte != 0 {
                if self.buffer.len() == MAX_CDP_FRAME_BYTES {
                    return Err(FramingError::FrameTooLarge {
                        max_bytes: MAX_CDP_FRAME_BYTES,
                    });
                }
                self.buffer.push(byte);
                continue;
            }

            if self.buffer.is_empty() {
                return Err(FramingError::EmptyFrame);
            }

            let frame = std::mem::take(&mut self.buffer);
            let value =
                serde_json::from_slice(&frame).map_err(|error| FramingError::InvalidJson {
                    message: error.to_string(),
                })?;
            messages.push(value);
        }

        Ok(messages)
    }

    pub fn finish(&self) -> Result<(), FramingError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(FramingError::TruncatedFrame {
                buffered_bytes: self.buffer.len(),
            })
        }
    }
}

pub fn write_json_frame<W: Write, T: Serialize>(
    writer: &mut W,
    message: &T,
) -> Result<(), FramingError> {
    let frame = encode_json_frame(message)?;
    writer
        .write_all(&frame)
        .and_then(|()| writer.flush())
        .map_err(write_error)
}

pub(crate) fn encode_json_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, FramingError> {
    let mut buffer = LimitedFrameBuffer::new();
    if let Err(error) = serde_json::to_writer(&mut buffer, message) {
        if buffer.limit_exceeded {
            return Err(FramingError::FrameTooLarge {
                max_bytes: MAX_CDP_FRAME_BYTES,
            });
        }
        return Err(FramingError::Write {
            message: error.to_string(),
        });
    }
    buffer.bytes.reserve_exact(1);
    buffer.bytes.push(0);
    Ok(buffer.bytes)
}

struct LimitedFrameBuffer {
    bytes: Vec<u8>,
    limit_exceeded: bool,
}

impl LimitedFrameBuffer {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            limit_exceeded: false,
        }
    }
}

impl Write for LimitedFrameBuffer {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let remaining = MAX_CDP_FRAME_BYTES - self.bytes.len();
        if input.len() > remaining {
            self.limit_exceeded = true;
            return Err(io::Error::other("CDP frame size limit exceeded"));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn write_error(error: io::Error) -> FramingError {
    FramingError::Write {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_fragmented_and_coalesced_messages() {
        let mut decoder = NulJsonDecoder::new();

        assert!(decoder.push(br#"{"id":1"#).unwrap().is_empty());
        assert_eq!(
            decoder.push(b"}\0{\"method\":\"Ready\"}\0").unwrap(),
            vec![json!({"id": 1}), json!({"method": "Ready"})]
        );
        assert_eq!(decoder.finish(), Ok(()));
    }

    #[test]
    fn rejects_empty_frame() {
        let mut decoder = NulJsonDecoder::new();
        assert_eq!(decoder.push(b"\0"), Err(FramingError::EmptyFrame));
    }

    #[test]
    fn rejects_invalid_json() {
        let mut decoder = NulJsonDecoder::new();
        assert!(matches!(
            decoder.push(b"{]\0"),
            Err(FramingError::InvalidJson { .. })
        ));
    }

    #[test]
    fn rejects_unterminated_frame_at_eof() {
        let mut decoder = NulJsonDecoder::new();
        decoder.push(br#"{"id":1}"#).unwrap();
        assert_eq!(
            decoder.finish(),
            Err(FramingError::TruncatedFrame { buffered_bytes: 8 })
        );
    }

    #[test]
    fn escaped_nul_is_json_content_not_a_delimiter() {
        let mut decoder = NulJsonDecoder::new();
        assert_eq!(
            decoder.push(b"{\"value\":\"a\\u0000b\"}\0").unwrap(),
            vec![json!({"value": "a\0b"})]
        );
    }

    #[test]
    fn writer_appends_exactly_one_nul() {
        let mut output = Vec::new();
        write_json_frame(&mut output, &json!({"id": 7})).unwrap();
        assert_eq!(output, b"{\"id\":7}\0");
    }

    #[test]
    fn writer_accepts_outbound_frame_at_exact_limit() {
        let message = "a".repeat(MAX_CDP_FRAME_BYTES - 2);
        let mut output = Vec::new();

        write_json_frame(&mut output, &message).unwrap();

        assert_eq!(output.len(), MAX_CDP_FRAME_BYTES + 1);
        assert_eq!(output.last(), Some(&0));
    }

    #[test]
    fn writer_rejects_oversized_outbound_frame_without_partial_output() {
        let message = "a".repeat(MAX_CDP_FRAME_BYTES - 1);
        let mut output = Vec::new();

        assert_eq!(
            write_json_frame(&mut output, &message),
            Err(FramingError::FrameTooLarge {
                max_bytes: MAX_CDP_FRAME_BYTES
            })
        );
        assert!(output.is_empty());
    }

    #[test]
    fn accepts_frame_at_maximum_size() {
        let payload_len = MAX_CDP_FRAME_BYTES - 12;
        let mut frame = Vec::with_capacity(MAX_CDP_FRAME_BYTES + 1);
        frame.extend_from_slice(b"{\"value\":\"");
        frame.extend(std::iter::repeat_n(b'a', payload_len));
        frame.extend_from_slice(b"\"}\0");

        let messages = NulJsonDecoder::new().push(&frame).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["value"].as_str().unwrap().len(), payload_len);
    }

    #[test]
    fn rejects_frame_exceeding_maximum_size() {
        let oversized = vec![b' '; MAX_CDP_FRAME_BYTES + 1];
        assert_eq!(
            NulJsonDecoder::new().push(&oversized),
            Err(FramingError::FrameTooLarge {
                max_bytes: MAX_CDP_FRAME_BYTES
            })
        );
    }
}
