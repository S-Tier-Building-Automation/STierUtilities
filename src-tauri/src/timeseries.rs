//! InfluxDB line-protocol encoding — the wire format the Observability Pack's
//! InfluxDB/Telegraf endpoints ingest. This is the pure, reusable core; Phase 3's
//! `timeseries_write` command batches `Point`s, encodes them here, and POSTs the
//! result to the local InfluxDB `/api/v2/write` endpoint.
//!
//! Portable (no Win32), so it is not behind the `#[cfg(windows)]` gate.
//!
//! Line protocol grammar (one measurement per line):
//!   measurement[,tag=val,...] field=val[,field=val,...] [timestamp_ns]
//! Escaping rules per the InfluxDB spec:
//!   - measurement: escape ',' and ' '
//!   - tag keys/values and field keys: escape ',', '=', ' '
//!   - string field values: wrap in '"' and escape '"' and '\'

// The encoder is wired to a Tauri command in Phase 3 (Observability Pack). Until
// then its public surface is exercised only by unit tests.
#![allow(dead_code)]

/// A typed field value. Integers get an `i` suffix, unsigned a `u`, per spec.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Float(f64),
    Int(i64),
    UInt(u64),
    Bool(bool),
    Str(String),
}

/// One measurement sample.
#[derive(Debug, Clone)]
pub struct Point {
    pub measurement: String,
    /// (key, value) tag pairs. Encoded in sorted-key order (InfluxDB best practice).
    pub tags: Vec<(String, String)>,
    /// (key, value) field pairs. At least one is required.
    pub fields: Vec<(String, FieldValue)>,
    /// Nanosecond epoch timestamp; omitted from the line when `None`.
    pub timestamp_ns: Option<i64>,
}

fn escape_measurement(s: &str) -> String {
    s.replace('\\', "\\\\").replace(',', "\\,").replace(' ', "\\ ")
}

fn escape_tag(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(',', "\\,")
        .replace('=', "\\=")
        .replace(' ', "\\ ")
}

fn escape_str_value(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn encode_field_value(v: &FieldValue) -> String {
    match v {
        FieldValue::Float(f) => {
            // Line protocol floats can't be NaN/Inf — caller should have filtered,
            // but be defensive and emit 0 rather than an invalid token.
            if f.is_finite() {
                // Ensure a decimal point isn't required; InfluxDB accepts plain ints
                // as floats, but keep full precision.
                let mut out = format!("{f}");
                if !out.contains('.') && !out.contains('e') && !out.contains('E') {
                    out.push_str(".0");
                }
                out
            } else {
                "0.0".to_string()
            }
        }
        FieldValue::Int(i) => format!("{i}i"),
        FieldValue::UInt(u) => format!("{u}u"),
        FieldValue::Bool(b) => if *b { "true".into() } else { "false".into() },
        FieldValue::Str(s) => format!("\"{}\"", escape_str_value(s)),
    }
}

/// Encode a single point to a line-protocol line (no trailing newline).
/// Returns an error if the measurement is empty or there are no fields.
pub fn to_line_protocol(p: &Point) -> Result<String, String> {
    if p.measurement.trim().is_empty() {
        return Err("measurement must not be empty".into());
    }
    if p.fields.is_empty() {
        return Err("point must have at least one field".into());
    }

    let mut line = escape_measurement(&p.measurement);

    // Tags, sorted by key for ingest efficiency and deterministic output.
    let mut tags = p.tags.clone();
    tags.sort_by(|a, b| a.0.cmp(&b.0));
    for (k, v) in &tags {
        if k.is_empty() || v.is_empty() {
            continue; // empty tag keys/values are invalid; skip rather than emit garbage
        }
        line.push(',');
        line.push_str(&escape_tag(k));
        line.push('=');
        line.push_str(&escape_tag(v));
    }

    line.push(' ');
    let fields: Vec<String> = p
        .fields
        .iter()
        .map(|(k, v)| format!("{}={}", escape_tag(k), encode_field_value(v)))
        .collect();
    line.push_str(&fields.join(","));

    if let Some(ts) = p.timestamp_ns {
        line.push(' ');
        line.push_str(&ts.to_string());
    }

    Ok(line)
}

/// Encode many points into a single newline-delimited body. Points that fail to
/// encode (e.g. no fields) are skipped; returns the body and the skipped count.
pub fn to_line_protocol_batch(points: &[Point]) -> (String, usize) {
    let mut lines = Vec::with_capacity(points.len());
    let mut skipped = 0;
    for p in points {
        match to_line_protocol(p) {
            Ok(l) => lines.push(l),
            Err(_) => skipped += 1,
        }
    }
    (lines.join("\n"), skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(m: &str, tags: &[(&str, &str)], fields: Vec<(&str, FieldValue)>, ts: Option<i64>) -> Point {
        Point {
            measurement: m.to_string(),
            tags: tags.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            fields: fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            timestamp_ns: ts,
        }
    }

    #[test]
    fn encodes_basic_point() {
        let p = pt("bacnet_point", &[("device", "12345")], vec![("present_value", FieldValue::Float(72.4))], Some(1000));
        assert_eq!(to_line_protocol(&p).unwrap(), "bacnet_point,device=12345 present_value=72.4 1000");
    }

    #[test]
    fn integer_and_bool_and_string_fields() {
        let p = pt(
            "m",
            &[],
            vec![
                ("count", FieldValue::Int(5)),
                ("ok", FieldValue::Bool(true)),
                ("status", FieldValue::Str("on line".into())),
            ],
            None,
        );
        assert_eq!(to_line_protocol(&p).unwrap(), r#"m count=5i,ok=true,status="on line""#);
    }

    #[test]
    fn whole_float_gets_decimal_point() {
        let p = pt("m", &[], vec![("v", FieldValue::Float(70.0))], None);
        assert_eq!(to_line_protocol(&p).unwrap(), "m v=70.0");
    }

    #[test]
    fn tags_are_sorted_and_escaped() {
        let p = pt(
            "my m",
            &[("z", "1"), ("a", "two words"), ("k,v", "x=y")],
            vec![("f", FieldValue::Int(1))],
            None,
        );
        // measurement space escaped; tags sorted a,k\,v,z; tag spaces/commas/equals escaped
        assert_eq!(
            to_line_protocol(&p).unwrap(),
            r"my\ m,a=two\ words,k\,v=x\=y,z=1 f=1i"
        );
    }

    #[test]
    fn string_value_escaping() {
        let p = pt("m", &[], vec![("s", FieldValue::Str(r#"a"b\c"#.into()))], None);
        assert_eq!(to_line_protocol(&p).unwrap(), r#"m s="a\"b\\c""#);
    }

    #[test]
    fn empty_tag_pairs_are_skipped() {
        let p = pt("m", &[("good", "1"), ("", "x"), ("empty", "")], vec![("f", FieldValue::Int(1))], None);
        assert_eq!(to_line_protocol(&p).unwrap(), "m,good=1 f=1i");
    }

    #[test]
    fn rejects_empty_measurement_and_no_fields() {
        assert!(to_line_protocol(&pt("", &[], vec![("f", FieldValue::Int(1))], None)).is_err());
        assert!(to_line_protocol(&pt("m", &[], vec![], None)).is_err());
    }

    #[test]
    fn non_finite_float_is_defused() {
        let p = pt("m", &[], vec![("v", FieldValue::Float(f64::INFINITY))], None);
        assert_eq!(to_line_protocol(&p).unwrap(), "m v=0.0");
    }

    #[test]
    fn batch_skips_invalid_and_joins() {
        let points = vec![
            pt("a", &[], vec![("f", FieldValue::Int(1))], None),
            pt("", &[], vec![("f", FieldValue::Int(2))], None), // invalid
            pt("b", &[], vec![("f", FieldValue::Int(3))], None),
        ];
        let (body, skipped) = to_line_protocol_batch(&points);
        assert_eq!(skipped, 1);
        assert_eq!(body, "a f=1i\nb f=3i");
    }
}
