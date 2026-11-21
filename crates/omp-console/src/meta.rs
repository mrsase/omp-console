//! Session metadata the header and resume flow need, kept fresh from the
//! replies the UI asks for and from the few events that change it.

use std::sync::RwLock;

use serde::Deserialize;

#[derive(Default, Clone)]
pub struct Meta {
    pub model: Option<String>,
    pub model_name: Option<String>,
    pub session_name: Option<String>,
    pub session_file: Option<String>,
    pub session_id: Option<String>,
    pub thinking: Option<String>,
}

fn same(before: &Meta, after: &Meta) -> bool {
    before.model == after.model
        && before.model_name == after.model_name
        && before.session_name == after.session_name
        && before.session_file == after.session_file
        && before.session_id == after.session_id
        && before.thinking == after.thinking
}

pub fn update(meta: &RwLock<Meta>, change: impl FnOnce(&mut Meta)) -> bool {
    let before = meta.read().expect("meta").clone();
    {
        let mut guard = meta.write().expect("meta");
        change(&mut guard);
    }
    let after = meta.read().expect("meta").clone();
    !same(&before, &after)
}

#[derive(Default, Deserialize)]
struct ModelSeed {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Default, Deserialize)]
struct StateSeed {
    #[serde(default)]
    model: Option<ModelSeed>,
    #[serde(default, rename = "sessionName")]
    session_name: Option<String>,
    #[serde(default, rename = "sessionFile")]
    session_file: Option<String>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default, rename = "thinkingLevel")]
    thinking: Option<String>,
}

#[derive(Default, Deserialize)]
struct StatsSeed {
    #[serde(default, rename = "sessionFile")]
    session_file: Option<String>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
}

pub fn apply_state(meta: &RwLock<Meta>, data: Option<&serde_json::Value>) -> bool {
    let Some(data) = data else { return false };
    let Ok(seed) = serde_json::from_value::<StateSeed>(data.clone()) else {
        return false;
    };
    update(meta, |meta| {
        if let Some(model) = seed.model
            && let (Some(provider), Some(id)) = (model.provider, model.id)
        {
            meta.model = Some(format!("{provider}/{id}"));
            meta.model_name = model.name;
        }
        if seed.session_name.is_some() {
            meta.session_name = seed.session_name;
        }
        if seed.session_file.is_some() {
            meta.session_file = seed.session_file;
        }
        if seed.session_id.is_some() {
            meta.session_id = seed.session_id;
        }
        if seed.thinking.is_some() {
            meta.thinking = seed.thinking;
        }
    })
}

pub fn apply_stats(meta: &RwLock<Meta>, data: Option<&serde_json::Value>) -> bool {
    let Some(data) = data else { return false };
    let Ok(seed) = serde_json::from_value::<StatsSeed>(data.clone()) else {
        return false;
    };
    update(meta, |meta| {
        if seed.session_file.is_some() {
            meta.session_file = seed.session_file;
        }
        if seed.session_id.is_some() {
            meta.session_id = seed.session_id;
        }
    })
}

/// Metadata carried by session events. `true` means the caller should ask for
/// a fresh `get_state` (model changes have no payload).
pub fn apply_event(meta: &RwLock<Meta>, kind: &str, raw: &str) -> bool {
    match kind {
        "session_info_update" => {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
                return false;
            };
            let title = value
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            update(meta, |meta| {
                if title.is_some() {
                    meta.session_name = title;
                }
                if session_id.is_some() {
                    meta.session_id = session_id;
                }
            });
            false
        }
        "thinking_level_changed" => {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
                return false;
            };
            let level = ["thinkingLevel", "configured", "resolved"]
                .iter()
                .find_map(|key| value.get(*key).and_then(|v| v.as_str()))
                .map(str::to_owned);
            if level.is_some() {
                update(meta, |meta| meta.thinking = level);
            }
            false
        }
        "config_update" => {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
                return false;
            };
            update(meta, |meta| {
                if let Some(model) = value.get("model")
                    && let (Some(provider), Some(id)) = (
                        model.get("provider").and_then(|v| v.as_str()),
                        model.get("id").and_then(|v| v.as_str()),
                    )
                {
                    meta.model = Some(format!("{provider}/{id}"));
                    meta.model_name = model
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                }
                if let Some(level) = value.get("thinkingLevel").and_then(|v| v.as_str()) {
                    meta.thinking = Some(level.to_owned());
                }
            });
            false
        }
        "model_changed" => true,
        _ => false,
    }
}
