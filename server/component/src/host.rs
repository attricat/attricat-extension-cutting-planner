//! Thin wrappers over the `attricat:host@1.2.0` imports. Every call is checked
//! by the host against the release's granted capabilities.

use std::collections::HashMap;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::attricat::host::api::{self, ReadRequest, ResolvedRead};
use crate::config::Config;
use crate::values::Values;

pub fn decode<T: DeserializeOwned>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("invalid {label}: {error}"))
}

pub fn encode(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "response serialization failed".to_owned())
}

pub fn configuration() -> Result<Config, String> {
    let raw = api::call("configuration.get.v1", "{}")?;
    serde_json::from_str(&raw).map_err(|error| format!("configuration: {error}"))
}

fn read_op(request: Value) -> Result<Value, String> {
    decode(
        &api::call("attricat.read.v1", &request.to_string())?,
        "read response",
    )
}

/// A published blueprint revision named by code.
#[derive(Clone, Debug)]
pub struct Blueprint {
    pub id: String,
    pub code: String,
    pub version: i64,
}

impl Blueprint {
    fn from_value(value: &Value) -> Option<Self> {
        // `BlueprintWithAttributes` nests the blueprint under `blueprint`.
        let inner = value
            .get("blueprint")
            .filter(|v| v.is_object())
            .unwrap_or(value);
        Some(Self {
            id: inner.get("id")?.as_str()?.to_owned(),
            code: inner.get("code")?.as_str()?.to_owned(),
            version: inner.get("version")?.as_i64()?,
        })
    }
}

/// One record with its values resolved in the session's context.
pub struct ReadRecord {
    pub blueprint: Blueprint,
    pub values: Values,
    /// The record's label as the host shows it in a relationship: the
    /// blueprint's dropdown fields joined by its separator.
    pub display: String,
}

/// The dropdown label from scalar fields; relationship fields are left out.
fn display_label(blueprint: &Value, values: &Values) -> String {
    let inner = blueprint
        .get("blueprint")
        .filter(|v| v.is_object())
        .unwrap_or(blueprint);
    let view = &inner["views"]["dropdown_option"];
    let separator = view
        .get("separator")
        .and_then(Value::as_str)
        .unwrap_or(" · ");
    view.get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|field| values.text(field))
        .collect::<Vec<_>>()
        .join(separator)
}

/// Host reads within one command, with blueprints and records cached so a
/// specification shared by many lines is read once.
pub struct Reader {
    pub context_id: String,
    blueprints: HashMap<String, Blueprint>,
    records: HashMap<String, std::rc::Rc<ReadRecord>>,
}

impl Reader {
    pub fn new(context_code: &str) -> Result<Self, String> {
        let context = read_op(json!({"operation": "context", "code": context_code}))?;
        let context_id = context
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("context '{context_code}' not found"))?
            .to_owned();
        Ok(Self {
            context_id,
            blueprints: HashMap::new(),
            records: HashMap::new(),
        })
    }

    pub fn blueprint(&mut self, code: &str) -> Result<Blueprint, String> {
        if let Some(found) = self.blueprints.get(code) {
            return Ok(found.clone());
        }
        let value = read_op(json!({"operation": "blueprint", "code": code}))?;
        let blueprint = Blueprint::from_value(&value)
            .ok_or_else(|| format!("blueprint '{code}' is not published"))?;
        self.blueprints.insert(code.to_owned(), blueprint.clone());
        Ok(blueprint)
    }

    pub fn record(&mut self, record_id: &str) -> Result<std::rc::Rc<ReadRecord>, String> {
        if let Some(found) = self.records.get(record_id) {
            return Ok(found.clone());
        }
        let response = api::read(&ReadRequest::Resolved(ResolvedRead {
            record_id: record_id.into(),
            context_id: self.context_id.clone(),
        }))?;
        let blueprint_value: Value = decode(&response.blueprint, "blueprint")?;
        let blueprint =
            Blueprint::from_value(&blueprint_value).ok_or("record without blueprint")?;
        let resolved: Value = decode(
            response.resolved_values.as_deref().unwrap_or("null"),
            "resolved values",
        )?;
        let direct: Vec<Value> = decode(&response.direct_values, "direct values")?;
        let attributes = blueprint_value
            .get("attributes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let values = Values::new(
            resolved.get("values").cloned().unwrap_or(Value::Null),
            &direct,
            &attributes,
            &self.context_id,
        );
        let display = display_label(&blueprint_value, &values);
        let record = std::rc::Rc::new(ReadRecord {
            blueprint,
            values,
            display,
        });
        self.records.insert(record_id.to_owned(), record.clone());
        Ok(record)
    }

    /// The first target of a relationship, read.
    pub fn target(
        &mut self,
        record: &ReadRecord,
        code: &str,
    ) -> Result<Option<std::rc::Rc<ReadRecord>>, String> {
        match record.values.target(code) {
            Some(id) => {
                let id = id.to_owned();
                self.record(&id).map(Some)
            }
            None => Ok(None),
        }
    }

    /// A value as a matching key and a label: a relationship by its target's
    /// ID and label, anything else by its text.
    pub fn key_and_label(
        &mut self,
        record: &ReadRecord,
        code: &str,
    ) -> Result<Option<(String, String)>, String> {
        if let Some(id) = record.values.target(code) {
            let id = id.to_owned();
            let target = self.record(&id)?;
            return Ok(Some((format!("@{id}"), target.display.clone())));
        }
        Ok(record.values.text(code).map(|text| (text.clone(), text)))
    }

    /// IDs of every live record of a blueprint, up to `cap`. `page` lists one
    /// revision, and records stay on the revision they were saved with until
    /// they are migrated, so every revision up to the latest is paged; a
    /// revision the host refuses (never published) is skipped.
    pub fn record_ids(&mut self, code: &str, cap: usize) -> Result<Vec<String>, String> {
        let blueprint = self.blueprint(code)?;
        let mut ids = Vec::new();
        for version in (1..=blueprint.version).rev() {
            let mut cursor: Option<String> = None;
            loop {
                let page = match read_op(json!({
                    "operation": "page",
                    "blueprint_id": blueprint.id,
                    "blueprint_version": version,
                    "context_id": self.context_id,
                    "publication_context_id": null,
                    "cursor": cursor,
                    "limit": 100,
                })) {
                    Ok(page) => page,
                    Err(_) if version != blueprint.version => break,
                    Err(error) => return Err(error),
                };
                for record in page
                    .get("records")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if record.get("deleted_at").is_some_and(|v| !v.is_null()) {
                        continue;
                    }
                    if let Some(id) = record.get("id").and_then(Value::as_str) {
                        ids.push(id.to_owned());
                    }
                }
                cursor = page
                    .get("next_cursor")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if cursor.is_none() || ids.len() >= cap {
                    break;
                }
            }
            if ids.len() >= cap {
                break;
            }
        }
        ids.truncate(cap);
        Ok(ids)
    }

    /// IDs of the records of `source` whose `field` links to `record_id`.
    pub fn incoming(
        &self,
        record_id: &str,
        source: &str,
        field: &str,
    ) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = read_op(json!({
                "operation": "incoming",
                "record_id": record_id,
                "relationships": [{"source_blueprint": source, "field": field}],
                "cursor": cursor,
                "limit": 100,
            }))?;
            for item in page
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    ids.push(id.to_owned());
                }
            }
            cursor = page
                .get("next_cursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() || ids.len() >= 1000 {
                return Ok(ids);
            }
        }
    }

    /// The one record of `code` whose `attribute` equals `value`.
    pub fn lookup(
        &mut self,
        code: &str,
        attribute: &str,
        value: &str,
    ) -> Result<Option<String>, String> {
        let blueprint = self.blueprint(code)?;
        let definition = read_op(json!({"operation": "blueprint", "code": code}))?;
        let attribute_id = definition
            .get("attributes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|a| a.get("code").and_then(Value::as_str) == Some(attribute))
            .and_then(|a| a.get("id").and_then(Value::as_str))
            .ok_or_else(|| format!("attribute '{attribute}' not found on '{code}'"))?
            .to_owned();
        let found = read_op(json!({
            "operation": "lookup",
            "blueprint_id": blueprint.id,
            "blueprint_version": blueprint.version,
            "attribute_id": attribute_id,
            "value": value,
        }))?;
        Ok(found.get("id").and_then(Value::as_str).map(str::to_owned))
    }
}

/// One intent's outcome from a write batch.
pub struct Outcome {
    pub intent_key: String,
    pub record_id: Option<String>,
    pub error: Option<String>,
}

/// Applies up to 100 intents. Intent keys make a retried batch
/// `already_applied` instead of writing twice.
pub fn apply_batch(batch_key: &str, intents: Vec<Value>) -> Result<Vec<Outcome>, String> {
    let request = json!({"operation": "batch", "batch": {"batch_key": batch_key, "dry_run": false, "intents": intents}});
    let outcomes: Vec<Value> = decode(
        &api::call("attricat.command.v1", &request.to_string())?,
        "batch outcome",
    )?;
    Ok(outcomes
        .into_iter()
        .map(|outcome| {
            let status = outcome.get("status").and_then(Value::as_str).unwrap_or("");
            Outcome {
                intent_key: outcome
                    .get("intent_key")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                record_id: outcome
                    .get("record_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                error: match status {
                    "applied" | "already_applied" => None,
                    _ => Some(
                        outcome
                            .get("error")
                            .map(Value::to_string)
                            .unwrap_or_else(|| status.to_owned()),
                    ),
                },
            }
        })
        .collect())
}

pub struct Stored {
    pub value: Value,
    pub revision: i64,
}

pub fn storage_get(key: &str) -> Result<Option<Stored>, String> {
    let response: Value = decode(
        &api::call("storage.get.v1", &json!({"key": key}).to_string())?,
        "storage entry",
    )?;
    if response.is_null() {
        return Ok(None);
    }
    Ok(Some(Stored {
        value: response.get("value").cloned().unwrap_or(Value::Null),
        revision: response
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    }))
}

pub fn storage_set(key: &str, value: &Value, expected_revision: Option<i64>) -> Result<(), String> {
    let mut request = json!({"key": key, "value": value});
    if let Some(revision) = expected_revision {
        request["expected_revision"] = json!(revision);
    }
    api::call("storage.set.v1", &request.to_string())?;
    Ok(())
}

/// Every stored value whose key starts with `prefix`, up to `cap`.
pub fn storage_list(prefix: &str, cap: usize) -> Result<Vec<Value>, String> {
    let mut values = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let response: Value = decode(
            &api::call(
                "storage.list.v1",
                &json!({"prefix": prefix, "cursor": cursor, "limit": 100}).to_string(),
            )?,
            "storage list",
        )?;
        for entry in response
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(value) = entry.get("value") {
                values.push(value.clone());
            }
        }
        cursor = response
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() || values.len() >= cap {
            return Ok(values);
        }
    }
}

pub fn log(level: &str, message: &str) {
    let _ = api::log(level, message);
}
