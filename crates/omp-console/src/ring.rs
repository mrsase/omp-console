use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::watch;

/// A byte-bounded, sequence-addressed log of already-wrapped WebSocket
/// messages. Subscribers read from a cursor; an overwritten cursor produces an
/// exact `Lagged(n)` so the client can resync.
pub struct FrameRing {
    inner: Mutex<Inner>,
    changes: watch::Sender<u64>,
    max_frames: usize,
    max_bytes: usize,
}

struct Inner {
    items: VecDeque<Arc<Bytes>>,
    first_seq: u64,
    next_seq: u64,
    bytes: usize,
    closed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Frame(Arc<Bytes>),
    Lagged(u64),
    Empty,
    Closed,
}

impl FrameRing {
    pub fn new(max_frames: usize, max_bytes: usize) -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            inner: Mutex::new(Inner {
                items: VecDeque::new(),
                first_seq: 0,
                next_seq: 0,
                bytes: 0,
                closed: false,
            }),
            changes,
            max_frames: max_frames.max(1),
            max_bytes: max_bytes.max(1),
        }
    }

    pub fn push(&self, frame: Bytes) {
        let mut inner = self.inner.lock().expect("frame ring");
        if inner.closed {
            return;
        }
        inner.bytes += frame.len();
        inner.items.push_back(Arc::new(frame));
        inner.next_seq += 1;
        while inner.items.len() > self.max_frames
            || (inner.bytes > self.max_bytes && inner.items.len() > 1)
        {
            if let Some(dropped) = inner.items.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(dropped.len());
                inner.first_seq += 1;
            }
        }
        let seq = inner.next_seq;
        drop(inner);
        let _ = self.changes.send(seq);
    }

    pub fn read(&self, cursor: &mut u64) -> Read {
        let inner = self.inner.lock().expect("frame ring");
        if *cursor < inner.first_seq {
            let skipped = inner.first_seq - *cursor;
            *cursor = inner.first_seq;
            return Read::Lagged(skipped);
        }
        if *cursor >= inner.next_seq {
            return if inner.closed {
                Read::Closed
            } else {
                Read::Empty
            };
        }
        let index = (*cursor - inner.first_seq) as usize;
        let frame = inner.items[index].clone();
        *cursor += 1;
        Read::Frame(frame)
    }

    pub fn close(&self) {
        let mut inner = self.inner.lock().expect("frame ring");
        inner.closed = true;
        let seq = inner.next_seq;
        drop(inner);
        let _ = self.changes.send(seq);
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn retained(&self) -> (usize, usize) {
        let inner = self.inner.lock().expect("frame ring");
        (inner.items.len(), inner.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_and_counts_lag() {
        let ring = FrameRing::new(3, 1024);
        for index in 0..5 {
            ring.push(Bytes::from(format!("{index}")));
        }
        let mut cursor = 0;
        assert_eq!(ring.read(&mut cursor), Read::Lagged(2));
        assert!(
            matches!(ring.read(&mut cursor), Read::Frame(frame) if frame.as_ref().as_ref() == b"2")
        );
        assert!(
            matches!(ring.read(&mut cursor), Read::Frame(frame) if frame.as_ref().as_ref() == b"3")
        );
        assert!(
            matches!(ring.read(&mut cursor), Read::Frame(frame) if frame.as_ref().as_ref() == b"4")
        );
        assert_eq!(ring.read(&mut cursor), Read::Empty);
    }

    #[test]
    fn bounds_bytes_but_keeps_one_large_frame() {
        let ring = FrameRing::new(100, 8);
        ring.push(Bytes::from_static(b"0123456789"));
        assert_eq!(ring.retained(), (1, 10));
        ring.push(Bytes::from_static(b"ab"));
        assert_eq!(ring.retained(), (1, 2));
    }

    #[test]
    fn closes_only_at_the_end() {
        let ring = FrameRing::new(4, 64);
        ring.push(Bytes::from_static(b"x"));
        ring.close();
        let mut cursor = 0;
        assert!(matches!(ring.read(&mut cursor), Read::Frame(_)));
        assert_eq!(ring.read(&mut cursor), Read::Closed);
    }
}
