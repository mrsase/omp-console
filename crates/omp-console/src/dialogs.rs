//! Pending extension UI requests, bounded and ordered. The ring is the durable
//! log; this queue is for a client that attaches after a lag and needs the
//! dialogs that are still open.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use bytes::Bytes;

pub const MAX_DIALOGS: usize = 64;

#[derive(Default)]
pub struct Dialogs {
    order: VecDeque<String>,
    map: HashMap<String, Arc<Bytes>>,
}

impl Dialogs {
    pub fn insert(&mut self, id: String, frame: Arc<Bytes>) {
        if self.map.insert(id.clone(), frame).is_none() {
            self.order.push_back(id);
        }
        while self.order.len() > MAX_DIALOGS {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.map.remove(id);
        self.order.retain(|item| item != id);
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }

    pub fn snapshot(&self) -> Vec<Arc<Bytes>> {
        self.order
            .iter()
            .filter_map(|id| self.map.get(id).cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_and_ordered() {
        let mut dialogs = Dialogs::default();
        for index in 0..(MAX_DIALOGS + 2) {
            dialogs.insert(
                format!("d{index}"),
                Arc::new(Bytes::from(format!("{index}"))),
            );
        }
        let snapshot = dialogs.snapshot();
        assert_eq!(snapshot.len(), MAX_DIALOGS);
        assert_eq!(snapshot[0].as_ref().as_ref(), b"2");
        dialogs.remove("d2");
        assert_eq!(dialogs.snapshot()[0].as_ref().as_ref(), b"3");
    }
}
