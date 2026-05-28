use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
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
    door_candidates: usize,
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
    let min_run = effective_grid.mul_add(0.45, 0.0).max(18.0) as u32;
    let snap = (effective_grid / 4.0).max(4.0);

    let mut horizontal = scan_horizontal(width, height, &mask, min_run, snap);
    let mut vertical = scan_vertical(width, height, &mask, min_run, snap);
    collapse_candidates(&mut horizontal, snap);
    collapse_candidates(&mut vertical, snap);

    let horizontal_count = horizontal.len();
    let vertical_count = vertical.len();
    let door_candidates = detect_door_candidates(&horizontal, &vertical, effective_grid, snap);
    let door_count = door_candidates.len();

    let mut candidates = horizontal;
    candidates.extend(vertical);
    candidates.sort_by(|a, b| b.length.total_cmp(&a.length));
    candidates.truncate(500);

    let mut occluders = candidates
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

    occluders.extend(
        door_candidates
            .into_iter()
            .enumerate()
            .map(|(index, candidate)| {
                let id = format!("door-{:04}", index + 1);
                Occluder::Door {
                    id,
                    x1: candidate.x1.clamp(0.0, width as f64),
                    y1: candidate.y1.clamp(0.0, height as f64),
                    x2: candidate.x2.clamp(0.0, width as f64),
                    y2: candidate.y2.clamp(0.0, height as f64),
                    open: false,
                }
            }),
    );

    let result = AnalysisResult {
        width,
        height,
        grid_scale: effective_grid,
        occluders,
        stats: AnalysisStats {
            dark_pixels,
            horizontal_candidates: horizontal_count,
            vertical_candidates: vertical_count,
            door_candidates: door_count,
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

fn detect_door_candidates(
    horizontal: &[Candidate],
    vertical: &[Candidate],
    grid_scale: f64,
    snap: f64,
) -> Vec<Candidate> {
    let mut doors = Vec::new();
    doors.extend(detect_axis_door_candidates(
        horizontal, true, grid_scale, snap,
    ));
    doors.extend(detect_axis_door_candidates(
        vertical, false, grid_scale, snap,
    ));
    collapse_candidates(&mut doors, snap);
    doors.sort_by(|a, b| b.length.total_cmp(&a.length));
    doors.truncate(200);
    doors
}

fn detect_axis_door_candidates(
    candidates: &[Candidate],
    horizontal: bool,
    grid_scale: f64,
    snap: f64,
) -> Vec<Candidate> {
    let min_gap = (grid_scale * 0.12).max(4.0);
    let max_gap = (grid_scale * 1.45).max(min_gap + 1.0);
    let min_support = (grid_scale * 0.28).max(12.0);
    let mut by_line: BTreeMap<i64, Vec<&Candidate>> = BTreeMap::new();

    for candidate in candidates {
        if candidate.horizontal != horizontal || candidate.length < min_support {
            continue;
        }

        let line_coord = if horizontal {
            candidate.y1
        } else {
            candidate.x1
        };
        by_line
            .entry(quantize(line_coord, snap))
            .or_default()
            .push(candidate);
    }

    let mut doors = Vec::new();
    for line_candidates in by_line.values_mut() {
        line_candidates.sort_by(|a, b| {
            let a_start = if horizontal {
                a.x1.min(a.x2)
            } else {
                a.y1.min(a.y2)
            };
            let b_start = if horizontal {
                b.x1.min(b.x2)
            } else {
                b.y1.min(b.y2)
            };
            a_start.total_cmp(&b_start)
        });

        for pair in line_candidates.windows(2) {
            let left = pair[0];
            let right = pair[1];
            let left_end = if horizontal {
                left.x1.max(left.x2)
            } else {
                left.y1.max(left.y2)
            };
            let right_start = if horizontal {
                right.x1.min(right.x2)
            } else {
                right.y1.min(right.y2)
            };
            let gap = right_start - left_end;

            if gap < min_gap || gap > max_gap {
                continue;
            }

            let line_coord = if horizontal {
                average(left.y1, right.y1)
            } else {
                average(left.x1, right.x1)
            };

            doors.push(if horizontal {
                Candidate {
                    horizontal: true,
                    x1: left_end,
                    y1: line_coord,
                    x2: right_start,
                    y2: line_coord,
                    length: gap,
                }
            } else {
                Candidate {
                    horizontal: false,
                    x1: line_coord,
                    y1: left_end,
                    x2: line_coord,
                    y2: right_start,
                    length: gap,
                }
            });
        }
    }

    doors
}

fn average(first: f64, second: f64) -> f64 {
    (first + second) / 2.0
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

    fn horizontal_candidate(x1: f64, x2: f64, y: f64) -> Candidate {
        Candidate {
            horizontal: true,
            x1,
            y1: y,
            x2,
            y2: y,
            length: (x2 - x1).abs(),
        }
    }

    fn vertical_candidate(y1: f64, y2: f64, x: f64) -> Candidate {
        Candidate {
            horizontal: false,
            x1: x,
            y1,
            x2: x,
            y2,
            length: (y2 - y1).abs(),
        }
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

    #[test]
    fn detects_horizontal_door_gap_between_wall_runs() {
        let doors = detect_door_candidates(
            &[
                horizontal_candidate(0.0, 125.0, 100.0),
                horizontal_candidate(150.0, 300.0, 100.0),
            ],
            &[],
            50.0,
            12.5,
        );

        assert_eq!(doors.len(), 1);
        let door = &doors[0];
        assert!(door.horizontal);
        assert_eq!(door.x1, 125.0);
        assert_eq!(door.x2, 150.0);
        assert_eq!(door.y1, 100.0);
    }

    #[test]
    fn detects_vertical_door_gap_between_wall_runs() {
        let doors = detect_door_candidates(
            &[],
            &[
                vertical_candidate(0.0, 125.0, 200.0),
                vertical_candidate(175.0, 300.0, 200.0),
            ],
            50.0,
            12.5,
        );

        assert_eq!(doors.len(), 1);
        let door = &doors[0];
        assert!(!door.horizontal);
        assert_eq!(door.x1, 200.0);
        assert_eq!(door.y1, 125.0);
        assert_eq!(door.y2, 175.0);
    }

    #[test]
    fn detects_off_grid_door_gap_between_wall_runs() {
        let doors = detect_door_candidates(
            &[
                horizontal_candidate(0.0, 96.0, 123.0),
                horizontal_candidate(118.0, 240.0, 123.0),
            ],
            &[],
            50.0,
            12.5,
        );

        assert_eq!(doors.len(), 1);
        let door = &doors[0];
        assert!(door.horizontal);
        assert_eq!(door.x1, 96.0);
        assert_eq!(door.x2, 118.0);
        assert_eq!(door.y1, 123.0);
    }

    #[test]
    fn detects_door_gap_with_short_wall_supports() {
        let doors = detect_door_candidates(
            &[
                horizontal_candidate(40.0, 58.0, 100.0),
                horizontal_candidate(70.0, 92.0, 100.0),
            ],
            &[],
            50.0,
            12.5,
        );

        assert_eq!(doors.len(), 1);
        let door = &doors[0];
        assert_eq!(door.x1, 58.0);
        assert_eq!(door.x2, 70.0);
    }

    #[test]
    fn ignores_large_corridor_gaps_as_doors() {
        let doors = detect_door_candidates(
            &[
                horizontal_candidate(0.0, 100.0, 100.0),
                horizontal_candidate(220.0, 320.0, 100.0),
            ],
            &[],
            50.0,
            12.5,
        );

        assert!(doors.is_empty());
    }
}
