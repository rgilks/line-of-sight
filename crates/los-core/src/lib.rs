use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum Occluder {
    #[serde(rename = "wall")]
    Wall {
        id: String,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    },
    #[serde(rename = "door")]
    Door {
        id: String,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        open: bool,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DoorState {
    Boolean(bool),
    Object { open: bool },
}

#[derive(Debug, Serialize)]
struct AnalysisResult {
    width: u32,
    height: u32,
    grid_scale: f64,
    occluders: Vec<Occluder>,
    stats: AnalysisStats,
}

#[derive(Debug, Serialize)]
struct AnalysisStats {
    dark_pixels: u32,
    horizontal_candidates: usize,
    vertical_candidates: usize,
}

#[derive(Clone, Debug)]
struct Candidate {
    horizontal: bool,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    length: f64,
}

impl Occluder {
    fn segment(&self) -> Segment {
        match self {
            Occluder::Wall { x1, y1, x2, y2, .. } | Occluder::Door { x1, y1, x2, y2, .. } => {
                Segment {
                    x1: *x1,
                    y1: *y1,
                    x2: *x2,
                    y2: *y2,
                }
            }
        }
    }

    fn is_open_door(&self, door_states: &HashMap<String, DoorState>) -> bool {
        match self {
            Occluder::Wall { .. } => false,
            Occluder::Door { id, open, .. } => match door_states.get(id) {
                Some(DoorState::Boolean(state)) => *state,
                Some(DoorState::Object { open }) => *open,
                None => *open,
            },
        }
    }

    fn is_blocking(&self, door_states: &HashMap<String, DoorState>) -> bool {
        !self.is_open_door(door_states)
    }
}

#[wasm_bindgen]
pub fn analyze_image_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
    grid_scale: f64,
) -> Result<JsValue, JsValue> {
    if width == 0 || height == 0 {
        return Err(JsValue::from_str("Image dimensions must be positive."));
    }

    let expected_len = width as usize * height as usize * 4;
    if rgba.len() != expected_len {
        return Err(JsValue::from_str(
            "RGBA buffer length does not match image dimensions.",
        ));
    }

    let effective_grid = if grid_scale.is_finite() && grid_scale > 0.0 {
        grid_scale
    } else {
        50.0
    };

    let mask = build_dark_mask(width, height, rgba);
    let dark_pixels = mask.iter().filter(|&&dark| dark).count() as u32;
    let min_run = effective_grid.mul_add(0.65, 0.0).max(30.0) as u32;
    let snap = (effective_grid / 4.0).max(4.0);

    let mut horizontal = scan_horizontal(width, height, &mask, min_run, snap);
    let mut vertical = scan_vertical(width, height, &mask, min_run, snap);
    collapse_candidates(&mut horizontal, snap);
    collapse_candidates(&mut vertical, snap);

    let horizontal_count = horizontal.len();
    let vertical_count = vertical.len();
    let mut candidates = horizontal;
    candidates.extend(vertical);
    candidates.sort_by(|a, b| b.length.total_cmp(&a.length));
    candidates.truncate(500);

    let occluders = candidates
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| {
            let id = format!("wall-{:04}", index + 1);
            Occluder::Wall {
                id,
                x1: candidate.x1.clamp(0.0, width as f64),
                y1: candidate.y1.clamp(0.0, height as f64),
                x2: candidate.x2.clamp(0.0, width as f64),
                y2: candidate.y2.clamp(0.0, height as f64),
            }
        })
        .collect::<Vec<_>>();

    let result = AnalysisResult {
        width,
        height,
        grid_scale: effective_grid,
        occluders,
        stats: AnalysisStats {
            dark_pixels,
            horizontal_candidates: horizontal_count,
            vertical_candidates: vertical_count,
        },
    };

    to_js(&result)
}

#[wasm_bindgen]
pub fn has_line_of_sight(
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    occluders: JsValue,
    door_states: JsValue,
) -> Result<bool, JsValue> {
    let occluders = parse_occluders(occluders)?;
    let door_states = parse_door_states(door_states)?;
    Ok(line_of_sight(
        Point {
            x: from_x,
            y: from_y,
        },
        Point { x: to_x, y: to_y },
        &occluders,
        &door_states,
    ))
}

#[wasm_bindgen]
pub fn visibility_polygon(
    viewer_x: f64,
    viewer_y: f64,
    width: f64,
    height: f64,
    radius: f64,
    occluders: JsValue,
    door_states: JsValue,
) -> Result<JsValue, JsValue> {
    if width <= 0.0 || height <= 0.0 || !width.is_finite() || !height.is_finite() {
        return Err(JsValue::from_str(
            "Board dimensions must be positive finite numbers.",
        ));
    }

    let viewer = Point {
        x: viewer_x.clamp(0.0, width),
        y: viewer_y.clamp(0.0, height),
    };
    let max_radius = if radius.is_finite() && radius > 0.0 {
        radius
    } else {
        width.hypot(height)
    };
    let occluders = parse_occluders(occluders)?;
    let door_states = parse_door_states(door_states)?;
    let mut segments = blocking_segments(&occluders, &door_states);
    segments.extend(board_segments(width, height));

    let mut angles = Vec::new();
    for step in 0..128 {
        angles.push((step as f64 / 128.0) * std::f64::consts::TAU);
    }

    for segment in &segments {
        for point in [
            Point {
                x: segment.x1,
                y: segment.y1,
            },
            Point {
                x: segment.x2,
                y: segment.y2,
            },
        ] {
            let angle = (point.y - viewer.y).atan2(point.x - viewer.x);
            angles.push(normalize_angle(angle - 0.0008));
            angles.push(normalize_angle(angle));
            angles.push(normalize_angle(angle + 0.0008));
        }
    }

    angles.sort_by(|a, b| a.total_cmp(b));
    angles.dedup_by(|a, b| (*a - *b).abs() < 0.000_001);

    let mut points = angles
        .into_iter()
        .filter_map(|angle| {
            cast_ray(viewer, angle, max_radius, &segments).map(|point| (angle, point))
        })
        .collect::<Vec<_>>();
    points.sort_by(|a, b| a.0.total_cmp(&b.0));

    let polygon = dedupe_polygon(points.into_iter().map(|(_, point)| point).collect());
    to_js(&polygon)
}

fn parse_occluders(value: JsValue) -> Result<Vec<Occluder>, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(Vec::new());
    }

    serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&format!("Invalid occluders: {error}")))
}

fn parse_door_states(value: JsValue) -> Result<HashMap<String, DoorState>, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(HashMap::new());
    }

    serde_wasm_bindgen::from_value(value)
        .map_err(|error| JsValue::from_str(&format!("Invalid door state lookup: {error}")))
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value)
        .map_err(|error| JsValue::from_str(&format!("Serialization failed: {error}")))
}

fn build_dark_mask(width: u32, height: u32, rgba: &[u8]) -> Vec<bool> {
    let mut mask = Vec::with_capacity(width as usize * height as usize);
    for y in 0..height {
        for x in 0..width {
            let index = ((y * width + x) * 4) as usize;
            let r = rgba[index] as f64;
            let g = rgba[index + 1] as f64;
            let b = rgba[index + 2] as f64;
            let a = rgba[index + 3];
            let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            mask.push(a > 32 && luminance < 58.0);
        }
    }
    mask
}

fn scan_horizontal(
    width: u32,
    height: u32,
    mask: &[bool],
    min_run: u32,
    snap: f64,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    for y in 0..height {
        let mut x = 0;
        while x < width {
            while x < width && !mask[(y * width + x) as usize] {
                x += 1;
            }
            let start = x;
            while x < width && mask[(y * width + x) as usize] {
                x += 1;
            }
            let end = x;
            if end > start && end - start >= min_run {
                let x1 = snap_value(start as f64, snap);
                let x2 = snap_value(end as f64, snap);
                let y1 = snap_value(y as f64, snap);
                candidates.push(Candidate {
                    horizontal: true,
                    x1,
                    y1,
                    x2,
                    y2: y1,
                    length: (x2 - x1).abs(),
                });
            }
        }
    }
    candidates
}

fn scan_vertical(
    width: u32,
    height: u32,
    mask: &[bool],
    min_run: u32,
    snap: f64,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    for x in 0..width {
        let mut y = 0;
        while y < height {
            while y < height && !mask[(y * width + x) as usize] {
                y += 1;
            }
            let start = y;
            while y < height && mask[(y * width + x) as usize] {
                y += 1;
            }
            let end = y;
            if end > start && end - start >= min_run {
                let y1 = snap_value(start as f64, snap);
                let y2 = snap_value(end as f64, snap);
                let x1 = snap_value(x as f64, snap);
                candidates.push(Candidate {
                    horizontal: false,
                    x1,
                    y1,
                    x2: x1,
                    y2,
                    length: (y2 - y1).abs(),
                });
            }
        }
    }
    candidates
}

fn collapse_candidates(candidates: &mut Vec<Candidate>, snap: f64) {
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        let key = (
            candidate.horizontal,
            quantize(candidate.x1, snap),
            quantize(candidate.y1, snap),
            quantize(candidate.x2, snap),
            quantize(candidate.y2, snap),
        );
        seen.insert(key)
    });
}

fn snap_value(value: f64, snap: f64) -> f64 {
    (value / snap).round() * snap
}

fn quantize(value: f64, snap: f64) -> i64 {
    (value / snap).round() as i64
}

fn line_of_sight(
    from: Point,
    to: Point,
    occluders: &[Occluder],
    door_states: &HashMap<String, DoorState>,
) -> bool {
    let sight = Segment {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
    };

    !occluders
        .iter()
        .filter(|occluder| occluder.is_blocking(door_states))
        .any(|occluder| segments_intersect(sight, occluder.segment()))
}

fn blocking_segments(
    occluders: &[Occluder],
    door_states: &HashMap<String, DoorState>,
) -> Vec<Segment> {
    occluders
        .iter()
        .filter(|occluder| occluder.is_blocking(door_states))
        .map(Occluder::segment)
        .collect()
}

fn board_segments(width: f64, height: f64) -> Vec<Segment> {
    vec![
        Segment {
            x1: 0.0,
            y1: 0.0,
            x2: width,
            y2: 0.0,
        },
        Segment {
            x1: width,
            y1: 0.0,
            x2: width,
            y2: height,
        },
        Segment {
            x1: width,
            y1: height,
            x2: 0.0,
            y2: height,
        },
        Segment {
            x1: 0.0,
            y1: height,
            x2: 0.0,
            y2: 0.0,
        },
    ]
}

fn segments_intersect(first: Segment, second: Segment) -> bool {
    let p1 = Point {
        x: first.x1,
        y: first.y1,
    };
    let q1 = Point {
        x: first.x2,
        y: first.y2,
    };
    let p2 = Point {
        x: second.x1,
        y: second.y1,
    };
    let q2 = Point {
        x: second.x2,
        y: second.y2,
    };

    let o1 = orientation(p1, q1, p2);
    let o2 = orientation(p1, q1, q2);
    let o3 = orientation(p2, q2, p1);
    let o4 = orientation(p2, q2, q1);

    if o1 != o2 && o3 != o4 {
        return true;
    }

    (o1 == 0 && on_segment(p2, p1, q1))
        || (o2 == 0 && on_segment(q2, p1, q1))
        || (o3 == 0 && on_segment(p1, p2, q2))
        || (o4 == 0 && on_segment(q1, p2, q2))
}

fn orientation(a: Point, b: Point, c: Point) -> i8 {
    let value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
    if value.abs() < 0.000_001 {
        0
    } else if value > 0.0 {
        1
    } else {
        -1
    }
}

fn on_segment(point: Point, start: Point, end: Point) -> bool {
    point.x >= start.x.min(end.x) - 0.000_001
        && point.x <= start.x.max(end.x) + 0.000_001
        && point.y >= start.y.min(end.y) - 0.000_001
        && point.y <= start.y.max(end.y) + 0.000_001
}

fn cast_ray(origin: Point, angle: f64, radius: f64, segments: &[Segment]) -> Option<Point> {
    let dx = angle.cos();
    let dy = angle.sin();
    let mut closest = Point {
        x: origin.x + dx * radius,
        y: origin.y + dy * radius,
    };
    let mut closest_distance = radius;

    for segment in segments {
        if let Some((distance, point)) = ray_segment_intersection(origin, dx, dy, *segment) {
            if distance >= 0.0 && distance < closest_distance {
                closest_distance = distance;
                closest = point;
            }
        }
    }

    Some(closest)
}

fn normalize_angle(angle: f64) -> f64 {
    let normalized = angle % std::f64::consts::TAU;
    if normalized < 0.0 {
        normalized + std::f64::consts::TAU
    } else {
        normalized
    }
}

fn ray_segment_intersection(
    origin: Point,
    dx: f64,
    dy: f64,
    segment: Segment,
) -> Option<(f64, Point)> {
    let sx = segment.x2 - segment.x1;
    let sy = segment.y2 - segment.y1;
    let denominator = cross(dx, dy, sx, sy);

    if denominator.abs() < 0.000_001 {
        return None;
    }

    let qpx = segment.x1 - origin.x;
    let qpy = segment.y1 - origin.y;
    let ray_distance = cross(qpx, qpy, sx, sy) / denominator;
    let segment_position = cross(qpx, qpy, dx, dy) / denominator;

    if ray_distance >= 0.0 && (0.0..=1.0).contains(&segment_position) {
        Some((
            ray_distance,
            Point {
                x: origin.x + dx * ray_distance,
                y: origin.y + dy * ray_distance,
            },
        ))
    } else {
        None
    }
}

fn cross(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    ax * by - ay * bx
}

fn dedupe_polygon(points: Vec<Point>) -> Vec<Point> {
    let mut deduped = Vec::new();
    for point in points {
        let duplicate = deduped.last().map_or(false, |last: &Point| {
            (last.x - point.x).abs() < 0.5 && (last.y - point.y).abs() < 0.5
        });
        if !duplicate {
            deduped.push(point);
        }
    }
    deduped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn door_states(open: bool) -> HashMap<String, DoorState> {
        HashMap::from([("door-1".to_string(), DoorState::Boolean(open))])
    }

    #[test]
    fn wall_blocks_line_of_sight() {
        let occluders = vec![Occluder::Wall {
            id: "wall-1".to_string(),
            x1: 5.0,
            y1: 0.0,
            x2: 5.0,
            y2: 10.0,
        }];

        assert!(!line_of_sight(
            Point { x: 0.0, y: 5.0 },
            Point { x: 10.0, y: 5.0 },
            &occluders,
            &HashMap::new()
        ));
    }

    #[test]
    fn open_door_does_not_block_line_of_sight() {
        let occluders = vec![Occluder::Door {
            id: "door-1".to_string(),
            x1: 5.0,
            y1: 0.0,
            x2: 5.0,
            y2: 10.0,
            open: false,
        }];

        assert!(line_of_sight(
            Point { x: 0.0, y: 5.0 },
            Point { x: 10.0, y: 5.0 },
            &occluders,
            &door_states(true)
        ));
    }

    #[test]
    fn closed_door_blocks_line_of_sight() {
        let occluders = vec![Occluder::Door {
            id: "door-1".to_string(),
            x1: 5.0,
            y1: 0.0,
            x2: 5.0,
            y2: 10.0,
            open: true,
        }];

        assert!(!line_of_sight(
            Point { x: 0.0, y: 5.0 },
            Point { x: 10.0, y: 5.0 },
            &occluders,
            &door_states(false)
        ));
    }
}
