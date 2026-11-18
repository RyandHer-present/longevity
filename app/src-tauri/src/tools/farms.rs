//! Farm Check. Finds farms in the parts of the world you spend time in (iron, spawner/mob, crop,
//! cane/bamboo/kelp/cactus, animal pens), works out a rate from the game's own rules, and refines
//! it with real numbers: the companion mod's live measuring, and the output chests' contents over
//! play time. The user can rename, retype, re-point outputs, hide, or add farms by hand.

use super::{now, read_json, write_json, R};
use crate::search::Index;
use crate::Ctx;
use mcassets::Assets;
use mcworld::nbt::V;
use mcworld::{Dim, World};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Random ticks: 3 per section per game tick, so one block gets one every 4096/3 ticks (68.3 s).
const RANDOM_TICK_S: f64 = 4096.0 / 3.0 / 20.0;

#[derive(Default, Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum F {
    #[default]
    Hopper,
    Chest,
    Bed,
    Farmland,
    Wheat,
    Carrots,
    Potatoes,
    Beetroots,
    NetherWart,
    Stem,
    Cane,
    Bamboo,
    Kelp,
    Cactus,
    Observer,
    Piston,
    Dispenser,
    Lava,
    Magma,
    Campfire,
    Composter,
    Trapdoor,
    Bell,
}

fn feature(name: &str) -> Option<F> {
    let s = name.trim_start_matches("minecraft:");
    Some(match s {
        "hopper" => F::Hopper,
        "chest" | "trapped_chest" | "barrel" => F::Chest,
        "farmland" => F::Farmland,
        "wheat" => F::Wheat,
        "carrots" => F::Carrots,
        "potatoes" => F::Potatoes,
        "beetroots" => F::Beetroots,
        "nether_wart" => F::NetherWart,
        "melon_stem" | "pumpkin_stem" | "attached_melon_stem" | "attached_pumpkin_stem" => F::Stem,
        "sugar_cane" => F::Cane,
        "bamboo" => F::Bamboo,
        "kelp" | "kelp_plant" => F::Kelp,
        "cactus" => F::Cactus,
        "observer" => F::Observer,
        "piston" | "sticky_piston" => F::Piston,
        "dispenser" | "dropper" => F::Dispenser,
        "lava" => F::Lava,
        "magma_block" => F::Magma,
        "campfire" | "soul_campfire" => F::Campfire,
        "composter" => F::Composter,
        "bell" => F::Bell,
        _ if s.ends_with("_bed") => F::Bed,
        _ if s.ends_with("_trapdoor") => F::Trapdoor,
        _ => return None,
    })
}

#[derive(Default)]
struct Scan {
    pts: HashMap<F, Vec<[i32; 3]>>,
    /// bottom block of each cane/bamboo/kelp/cactus column (one plant = one column)
    plants: HashMap<F, Vec<[i32; 3]>>,
    spawners: Vec<([i32; 3], String)>,
    ents: Vec<(String, [f64; 3], Option<String>)>,
}

fn scan_dim(world: &World, dim: Dim, chunks: &[(i32, i32)]) -> Scan {
    let parts: Vec<Scan> = chunks
        .par_iter()
        .filter_map(|&(cx, cz)| {
            let reg = world.region(dim, cx >> 5, cz >> 5)?;
            let c = World::chunk_uncached(&reg, (cx & 31) as usize, (cz & 31) as usize)?;
            let mut s = Scan::default();
            for (si, sec) in c.sections.iter().enumerate() {
                let Some(sec) = sec else { continue };
                let feats: Vec<Option<F>> = sec.palette.iter().map(|b| feature(&b.name)).collect();
                if feats.iter().all(|f| f.is_none()) {
                    continue;
                }
                let y0 = (c.min_section + si as i32) * 16;
                for y in 0..16 {
                    for z in 0..16 {
                        for x in 0..16 {
                            let pi = sec.data[blockdata::Section::index(x, y, z)] as usize;
                            let Some(f) = feats[pi] else { continue };
                            let p = [cx * 16 + x as i32, y0 + y as i32, cz * 16 + z as i32];
                            s.pts.entry(f).or_default().push(p);
                            if matches!(f, F::Cane | F::Bamboo | F::Kelp | F::Cactus) {
                                // bottom of a column: the block below is a different block
                                let below_same = if y > 0 {
                                    feats[sec.data[blockdata::Section::index(x, y - 1, z)] as usize] == Some(f)
                                } else {
                                    c.block(x, y0 + y as i32 - 1, z).and_then(|b| feature(&b.name)) == Some(f)
                                };
                                if !below_same {
                                    s.plants.entry(f).or_default().push(p);
                                }
                            }
                        }
                    }
                }
            }
            for be in &c.block_entities {
                if be.get_str("id") == Some("minecraft:mob_spawner") {
                    let mob = be.path(&["SpawnData", "entity", "id"]).and_then(|v| v.str()).unwrap_or("minecraft:pig").to_string();
                    s.spawners.push(([be.get_i64("x").unwrap_or(0) as i32, be.get_i64("y").unwrap_or(0) as i32, be.get_i64("z").unwrap_or(0) as i32], mob));
                }
            }
            Some(s)
        })
        .collect();
    let mut out = Scan::default();
    for p in parts {
        for (k, v) in p.pts {
            out.pts.entry(k).or_default().extend(v);
        }
        for (k, v) in p.plants {
            out.plants.entry(k).or_default().extend(v);
        }
        out.spawners.extend(p.spawners);
    }
    let set: HashSet<(i32, i32)> = chunks.iter().copied().collect();
    let regions: HashSet<(i32, i32)> = chunks.iter().map(|(x, z)| (x >> 5, z >> 5)).collect();
    let ents: Vec<(String, [f64; 3], Option<String>)> = regions
        .par_iter()
        .flat_map(|&(rx, rz)| {
            world
                .entities_in_region(dim, rx, rz)
                .into_iter()
                .filter_map(|e| {
                    let id = e.get_str("id")?.to_string();
                    let pos = e.get_list("Pos");
                    if pos.len() != 3 {
                        return None;
                    }
                    let p = [pos[0].f64()?, pos[1].f64()?, pos[2].f64()?];
                    if !set.contains(&((p[0].floor() as i32) >> 4, (p[2].floor() as i32) >> 4)) {
                        return None;
                    }
                    let prof = e.get("VillagerData").and_then(|v| v.get_str("profession")).map(str::to_string);
                    Some((id, p, prof))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    out.ents = ents;
    out
}

/// Group points that sit within `r` blocks of each other (single-link, grid-bucketed).
fn cluster(points: &[[i32; 3]], r: i32) -> Vec<Vec<[i32; 3]>> {
    let n = points.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize {
        let mut i = i;
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    let key = |p: &[i32; 3]| (p[0].div_euclid(r), p[1].div_euclid(r), p[2].div_euclid(r));
    let mut grid: HashMap<(i32, i32, i32), Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        grid.entry(key(p)).or_default().push(i);
    }
    let r2 = (r * r) as i64;
    for (i, p) in points.iter().enumerate() {
        let (kx, ky, kz) = key(p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = grid.get(&(kx + dx, ky + dy, kz + dz)) {
                        for &j in list {
                            if j <= i {
                                continue;
                            }
                            let q = points[j];
                            let d = (p[0] - q[0]) as i64 * (p[0] - q[0]) as i64 + (p[1] - q[1]) as i64 * (p[1] - q[1]) as i64 + (p[2] - q[2]) as i64 * (p[2] - q[2]) as i64;
                            if d <= r2 {
                                let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                                if a != b {
                                    parent[a] = b;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<[i32; 3]>> = HashMap::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(points[i]);
    }
    groups.into_values().collect()
}

fn bbox(pts: &[[i32; 3]]) -> [i32; 6] {
    let mut b = [i32::MAX, i32::MAX, i32::MAX, i32::MIN, i32::MIN, i32::MIN];
    for p in pts {
        for k in 0..3 {
            b[k] = b[k].min(p[k]);
            b[k + 3] = b[k + 3].max(p[k]);
        }
    }
    b
}

fn center(b: &[i32; 6]) -> [i32; 3] {
    [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]
}

fn near(b: &[i32; 6], p: [i32; 3], m: i32) -> bool {
    p[0] >= b[0] - m && p[0] <= b[3] + m && p[1] >= b[1] - m && p[1] <= b[4] + m && p[2] >= b[2] - m && p[2] <= b[5] + m
}

fn count_in(pts: Option<&Vec<[i32; 3]>>, b: &[i32; 6], m: i32) -> usize {
    pts.map(|v| v.iter().filter(|p| near(b, **p, m)).count()).unwrap_or(0)
}

/// Average drops per kill that don't need a player kill (farms kill mobs automatically).
fn mob_drops(mob: &str) -> Vec<(&'static str, f64)> {
    match mob.trim_start_matches("minecraft:") {
        "zombie" | "husk" | "drowned" | "zombie_villager" => vec![("minecraft:rotten_flesh", 1.0)],
        "skeleton" | "stray" | "bogged" => vec![("minecraft:bone", 1.0), ("minecraft:arrow", 1.0)],
        "spider" | "cave_spider" => vec![("minecraft:string", 1.0)],
        "creeper" => vec![("minecraft:gunpowder", 1.0)],
        "blaze" => vec![],
        "magma_cube" => vec![("minecraft:magma_cream", 0.25)],
        "silverfish" => vec![],
        "zombified_piglin" => vec![("minecraft:rotten_flesh", 0.5), ("minecraft:gold_nugget", 0.5)],
        "enderman" => vec![("minecraft:ender_pearl", 0.5)],
        "witch" => vec![("minecraft:redstone", 0.75), ("minecraft:glowstone_dust", 0.75), ("minecraft:sugar", 0.75), ("minecraft:glass_bottle", 0.75), ("minecraft:gunpowder", 0.75), ("minecraft:spider_eye", 0.75), ("minecraft:stick", 0.75)],
        _ => vec![],
    }
}

#[derive(Clone, Debug)]
struct Found {
    id: String,
    kind: &'static str,
    sub: String,
    name: String,
    dim: Dim,
    bbox: [i32; 6],
    units: f64,
    auto: bool,
    /// item -> per hour, from the rules
    rules: Vec<(String, f64)>,
    why: Vec<String>,
    confidence: &'static str,
}

fn crop_rate(f: F) -> (&'static str, f64, Vec<(&'static str, f64)>) {
    // (label, minutes per full growth, drops per harvest) for crops in good, hydrated rows
    match f {
        F::Wheat => ("wheat", 7.0 * RANDOM_TICK_S * 4.0 / 60.0, vec![("minecraft:wheat", 1.0), ("minecraft:wheat_seeds", 1.71)]),
        F::Carrots => ("carrots", 7.0 * RANDOM_TICK_S * 4.0 / 60.0, vec![("minecraft:carrot", 2.71)]),
        F::Potatoes => ("potatoes", 7.0 * RANDOM_TICK_S * 4.0 / 60.0, vec![("minecraft:potato", 2.71)]),
        F::Beetroots => ("beetroots", 3.0 * RANDOM_TICK_S * 4.0 / 60.0, vec![("minecraft:beetroot", 1.0), ("minecraft:beetroot_seeds", 1.71)]),
        F::NetherWart => ("nether wart", 3.0 * RANDOM_TICK_S * 10.0 / 60.0, vec![("minecraft:nether_wart", 3.0)]),
        _ => ("crops", 30.0, vec![]),
    }
}

fn detect(ctx: &Ctx) -> Vec<Found> {
    let mut out = Vec::new();
    for dim in [Dim::Overworld, Dim::Nether, Dim::End] {
        let e = ctx.explored(dim);
        // where you actually spend time: the top chunks by time spent (InhabitedTime)
        let mut chunks: Vec<((i32, i32), i64)> = e.visited.iter().filter(|(_, t)| **t > 1200).map(|(k, t)| (*k, *t)).collect();
        chunks.sort_by(|a, b| b.1.cmp(&a.1));
        chunks.truncate(900);
        if chunks.is_empty() {
            continue;
        }
        let list: Vec<(i32, i32)> = chunks.iter().map(|c| c.0).collect();
        let s = scan_dim(&ctx.world, dim, &list);
        let ents_of = |ids: &[&str]| -> Vec<[i32; 3]> { s.ents.iter().filter(|(id, _, _)| ids.iter().any(|x| id.ends_with(x))).map(|(_, p, _)| [p[0].floor() as i32, p[1].floor() as i32, p[2].floor() as i32]).collect() };
        let mut used: Vec<[i32; 6]> = Vec::new();
        let overlaps = |used: &Vec<[i32; 6]>, b: &[i32; 6]| used.iter().any(|u| !(b[3] < u[0] || b[0] > u[3] || b[5] < u[2] || b[2] > u[5] || b[4] < u[1] - 8 || b[1] > u[4] + 8));

        // 1) spawner farms: a spawner with hoppers near it
        for (p, mob) in &s.spawners {
            let b = [p[0] - 4, p[1] - 12, p[2] - 4, p[0] + 4, p[1] + 4, p[2] + 4];
            let hop = count_in(s.pts.get(&F::Hopper), &b, 8);
            if hop == 0 {
                continue;
            }
            let mob_name = mob.trim_start_matches("minecraft:").replace('_', " ");
            // a cycle every 200-800 ticks (avg 25 s), up to 4 tries; ~2.5 mobs per cycle in a good farm
            let per_hour = 3600.0 / 25.0 * 2.5;
            let rules: Vec<(String, f64)> = mob_drops(mob).into_iter().map(|(i, n)| (i.to_string(), per_hour * n)).collect();
            out.push(Found {
                id: format!("spawner@{},{},{}", p[0], p[1], p[2]),
                kind: "mob",
                sub: mob.clone(),
                name: format!("{} spawner farm", cap(&mob_name)),
                dim,
                bbox: b,
                units: 1.0,
                auto: true,
                rules,
                why: vec![format!("{} spawner", cap(&mob_name)), format!("{hop} hoppers nearby")],
                confidence: "good",
            });
            used.push(b);
        }

        // 2) iron farms: 3+ villagers packed together, with a kill setup (lava/campfire/magma) and hoppers
        let villagers = ents_of(&["minecraft:villager"]);
        let golems = ents_of(&["iron_golem"]);
        for g in cluster(&villagers, 6) {
            if g.len() < 3 {
                continue;
            }
            let vb = bbox(&g);
            let b = [vb[0] - 10, vb[1] - 14, vb[2] - 10, vb[3] + 10, vb[4] + 4, vb[5] + 10];
            let kill = count_in(s.pts.get(&F::Lava), &b, 0) + count_in(s.pts.get(&F::Campfire), &b, 0) + count_in(s.pts.get(&F::Magma), &b, 0);
            let hop = count_in(s.pts.get(&F::Hopper), &b, 0);
            let beds = count_in(s.pts.get(&F::Bed), &vb, 4);
            let golem_n = golems.iter().filter(|p| near(&b, **p, 0)).count();
            if hop == 0 || (kill == 0 && golem_n == 0) {
                continue;
            }
            let units = (g.len() as f64 / 3.0).floor().max(1.0).min(4.0);
            // one golem per ~35 s per 3-villager unit (30 s "saw a golem" cooldown + spawn and kill),
            // 3-5 iron (avg 4) and 0-2 poppies (avg 1) each
            let golems_h = 3600.0 / 35.0 * units;
            out.push(Found {
                id: format!("iron@{},{}", vb[0] >> 4, vb[2] >> 4),
                kind: "iron",
                sub: String::new(),
                name: "Iron farm".into(),
                dim,
                bbox: b,
                units,
                auto: true,
                rules: vec![("minecraft:iron_ingot".into(), golems_h * 4.0), ("minecraft:poppy".into(), golems_h)],
                why: vec![format!("{} villagers packed together", g.len()), format!("{hop} hoppers"), if kill > 0 { "lava / campfire kill floor".into() } else { format!("{golem_n} iron golem(s) inside") }, if beds > 0 { format!("{beds} beds") } else { "no beds".into() }],
                confidence: if kill > 0 && beds >= 3 { "good" } else { "rough" },
            });
            used.push(b);
        }

        // 3) crop farms: fields of farmland; automatic if farmer villagers, observers or water flush hoppers
        if let Some(farmland) = s.pts.get(&F::Farmland) {
            for g in cluster(farmland, 3) {
                if g.len() < 20 {
                    continue;
                }
                let b0 = bbox(&g);
                let b = [b0[0], b0[1] - 3, b0[2], b0[3], b0[4] + 2, b0[5]];
                if overlaps(&used, &b) {
                    continue;
                }
                let crops: Vec<(F, usize)> = [F::Wheat, F::Carrots, F::Potatoes, F::Beetroots, F::Stem].iter().map(|f| (*f, count_in(s.pts.get(f), &b, 0))).filter(|x| x.1 > 0).collect();
                let farmers = s.ents.iter().filter(|(id, p, prof)| id.ends_with("villager") && prof.as_deref() == Some("minecraft:farmer") && near(&b, [p[0] as i32, p[1] as i32, p[2] as i32], 2)).count();
                let hop = count_in(s.pts.get(&F::Hopper), &b, 3);
                let obs = count_in(s.pts.get(&F::Observer), &b, 2) + count_in(s.pts.get(&F::Dispenser), &b, 2);
                let auto = farmers > 0 || (hop > 0 && obs > 0);
                // a village's own fields: hand-tended, small, with a village bell close by
                let village = !auto && g.len() <= 64 && count_in(s.pts.get(&F::Bell), &b, 48) > 0;
                let mut rules = Vec::new();
                let mut why = vec![format!("{} farmland", g.len())];
                if village {
                    why.push("a village bell nearby".into());
                }
                let mut main = "crops";
                for (f, n) in &crops {
                    if *f == F::Stem {
                        // a stem makes a fruit about every 30 minutes once grown
                        rules.push(("minecraft:melon_slice".to_string(), *n as f64 * 2.0 * 5.0 * 0.5));
                        rules.push(("minecraft:pumpkin".to_string(), *n as f64 * 2.0 * 0.5));
                        why.push(format!("{n} melon/pumpkin stems"));
                        continue;
                    }
                    let (label, minutes, drops) = crop_rate(*f);
                    main = label;
                    for (item, avg) in drops {
                        rules.push((item.to_string(), *n as f64 * (60.0 / minutes) * avg));
                    }
                    why.push(format!("{n} {label}"));
                }
                if farmers > 0 {
                    why.push(format!("{farmers} farmer villager(s)"));
                }
                if rules.is_empty() {
                    continue;
                }
                out.push(Found {
                    id: format!("crop@{},{}", b0[0] >> 4, b0[2] >> 4),
                    kind: "crop",
                    sub: main.to_string(),
                    name: if auto {
                        format!("Auto {main} farm")
                    } else if village {
                        format!("Village {main} field")
                    } else {
                        format!("{} field", cap(main))
                    },
                    dim,
                    bbox: b,
                    units: 1.0,
                    auto,
                    rules,
                    why,
                    confidence: if auto {
                        "good"
                    } else if village {
                        "maybe"
                    } else {
                        "manual"
                    },
                });
                used.push(b);
            }
        }
        // nether wart has no farmland
        if let Some(w) = s.pts.get(&F::NetherWart) {
            for g in cluster(w, 3) {
                if g.len() < 12 {
                    continue;
                }
                let b = bbox(&g);
                let (_, minutes, drops) = crop_rate(F::NetherWart);
                out.push(Found {
                    id: format!("wart@{},{}", b[0] >> 4, b[2] >> 4),
                    kind: "crop",
                    sub: "nether wart".into(),
                    name: "Nether wart farm".into(),
                    dim,
                    bbox: b,
                    units: 1.0,
                    auto: count_in(s.pts.get(&F::Hopper), &b, 3) > 0,
                    rules: drops.into_iter().map(|(i, a)| (i.to_string(), g.len() as f64 * 60.0 / minutes * a)).collect(),
                    why: vec![format!("{} nether wart", g.len())],
                    confidence: "rough",
                });
            }
        }

        // 4) cane / bamboo / kelp / cactus: plants with observers and pistons (or hoppers for cactus)
        for (f, label, item, per_plant_h) in [
            (F::Cane, "Sugar cane", "minecraft:sugar_cane", 3600.0 / (16.0 * RANDOM_TICK_S)),
            (F::Bamboo, "Bamboo", "minecraft:bamboo", 3600.0 / (3.0 * RANDOM_TICK_S)),
            (F::Kelp, "Kelp", "minecraft:kelp", 3600.0 / (RANDOM_TICK_S / 0.14)),
            (F::Cactus, "Cactus", "minecraft:cactus", 3600.0 / (16.0 * RANDOM_TICK_S)),
        ] {
            let Some(plants) = s.plants.get(&f) else { continue };
            for g in cluster(plants, 4) {
                if g.len() < 6 {
                    continue;
                }
                let b0 = bbox(&g);
                let b = [b0[0] - 1, b0[1] - 2, b0[2] - 1, b0[3] + 1, b0[4] + 4, b0[5] + 1];
                let obs = count_in(s.pts.get(&F::Observer), &b, 1);
                let pis = count_in(s.pts.get(&F::Piston), &b, 1);
                let hop = count_in(s.pts.get(&F::Hopper), &b, 4);
                let auto = (obs > 0 && pis > 0) || (f == F::Cactus && hop > 0) || (f == F::Bamboo && obs > 0);
                // natural kelp forests are never farms; hand-harvested cane, bamboo and cactus might
                // be, or might be a riverbank, so they're only "maybe" until you say it's yours
                if !auto && (g.len() < 16 || f == F::Kelp) {
                    continue;
                }
                out.push(Found {
                    id: format!("{}@{},{}", label.to_lowercase().replace(' ', "_"), b0[0] >> 4, b0[2] >> 4),
                    kind: "crop",
                    sub: label.to_lowercase(),
                    name: if auto { format!("{label} farm") } else { format!("{label} patch") },
                    dim,
                    bbox: b,
                    units: 1.0,
                    auto,
                    rules: vec![(item.to_string(), g.len() as f64 * per_plant_h)],
                    why: if auto { vec![format!("{} plants", g.len()), format!("{obs} observers, {pis} pistons")] } else { vec![format!("{} plants", g.len()), "no observers or pistons (could be wild)".into()] },
                    confidence: if auto { "good" } else { "maybe" },
                });
            }
        }

        // 5) animal pens and breeders
        for (ids, label, per_adult) in [
            (&["minecraft:chicken"][..], "Chicken", vec![("minecraft:egg", 3600.0 / 450.0)]),
            (&["minecraft:cow", "minecraft:mooshroom"][..], "Cow", vec![("minecraft:leather", 1.0), ("minecraft:beef", 2.0)]),
            (&["minecraft:sheep"][..], "Sheep", vec![("minecraft:white_wool", 1.0), ("minecraft:mutton", 1.5)]),
            (&["minecraft:pig"][..], "Pig", vec![("minecraft:porkchop", 2.0)]),
            (&["minecraft:rabbit"][..], "Rabbit", vec![("minecraft:rabbit_hide", 0.5), ("minecraft:rabbit", 0.5)]),
        ] {
            let pts = ents_of(ids);
            for g in cluster(&pts, 5) {
                if g.len() < 6 {
                    continue;
                }
                let b0 = bbox(&g);
                let b = [b0[0] - 2, b0[1] - 4, b0[2] - 2, b0[3] + 2, b0[4] + 2, b0[5] + 2];
                let hop = count_in(s.pts.get(&F::Hopper), &b, 1);
                let disp = count_in(s.pts.get(&F::Dispenser), &b, 2);
                let kind_label = label.to_lowercase();
                let (auto, rules, name): (bool, Vec<(String, f64)>, String) = if label == "Chicken" {
                    // an adult chicken lays an egg every 6000-12000 ticks (7.5 min average)
                    (hop > 0, per_adult.iter().map(|(i, n)| (i.to_string(), g.len() as f64 * n)).collect(), if hop > 0 { "Egg farm".into() } else { "Chicken pen".into() })
                } else if disp > 0 {
                    // auto breeder: each pair can breed every 5 minutes
                    let babies = (g.len() as f64 / 2.0).floor() * 12.0;
                    (true, per_adult.iter().map(|(i, n)| (i.to_string(), babies * n)).collect(), format!("{label} breeder"))
                } else {
                    // a pen you breed by hand: what's there if you culled half
                    (false, per_adult.iter().map(|(i, n)| (i.to_string(), (g.len() as f64 / 2.0) * n)).collect(), format!("{label} pen"))
                };
                out.push(Found {
                    id: format!("{}@{},{}", kind_label, b0[0] >> 4, b0[2] >> 4),
                    kind: "animal",
                    sub: kind_label.clone(),
                    name,
                    dim,
                    bbox: b,
                    units: 1.0,
                    auto,
                    rules,
                    why: vec![format!("{} {}s", g.len(), kind_label), format!("{hop} hoppers, {disp} dispensers")],
                    confidence: if auto { "rough" } else { "manual" },
                });
            }
        }

        // 6) other mob farms: a big hopper line with a kill setup, not already a farm above
        if let Some(hops) = s.pts.get(&F::Hopper) {
            for g in cluster(hops, 2) {
                if g.len() < 10 {
                    continue;
                }
                let b0 = bbox(&g);
                let b = [b0[0] - 6, b0[1] - 4, b0[2] - 6, b0[3] + 6, b0[4] + 40, b0[5] + 6];
                if overlaps(&used, &b0) {
                    continue;
                }
                let traps = count_in(s.pts.get(&F::Trapdoor), &b, 0);
                let magma = count_in(s.pts.get(&F::Magma), &b, 0) + count_in(s.pts.get(&F::Campfire), &b, 0);
                if traps < 8 && magma == 0 {
                    continue;
                }
                let (name, rules): (String, Vec<(String, f64)>) = if dim == Dim::Nether {
                    ("Gold farm".into(), vec![("minecraft:rotten_flesh".into(), 600.0), ("minecraft:gold_nugget".into(), 600.0)])
                } else if dim == Dim::End {
                    ("Enderman farm".into(), vec![("minecraft:ender_pearl".into(), 500.0)])
                } else {
                    ("Mob farm".into(), vec![("minecraft:rotten_flesh".into(), 120.0), ("minecraft:bone".into(), 120.0), ("minecraft:arrow".into(), 120.0), ("minecraft:gunpowder".into(), 80.0), ("minecraft:string".into(), 80.0)])
                };
                out.push(Found {
                    id: format!("mob@{},{}", b0[0] >> 4, b0[2] >> 4),
                    kind: "mob",
                    sub: "platform".into(),
                    name,
                    dim,
                    bbox: b,
                    units: 1.0,
                    auto: true,
                    rules,
                    why: vec![format!("{} hoppers in a row", g.len()), format!("{traps} trapdoors"), format!("{magma} magma/campfires")],
                    confidence: "rough",
                });
                used.push(b);
            }
        }
    }
    out
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn user_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.dir.join("farms.json")
}

fn user(ctx: &Ctx) -> Value {
    read_json(&user_path(ctx)).unwrap_or(json!({ "edits": {}, "custom": [] }))
}

static CACHE: OnceLock<Mutex<HashMap<String, (i64, Vec<Found>)>>> = OnceLock::new();

fn detected(ctx: &Ctx) -> Vec<Found> {
    let key = ctx.entry.path.to_string_lossy().to_string();
    let stamp = ctx.world.regions(Dim::Overworld).iter().map(|r| mcworld::world::mtime_ms(&r.2)).max().unwrap_or(0);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((s, f)) = cache.lock().get(&key) {
        if *s == stamp {
            return f.clone();
        }
    }
    let f = detect(ctx);
    cache.lock().insert(key, (stamp, f.clone()));
    f
}

/// Containers that a farm feeds: within the farm's box (plus a small margin), but never the
/// player's inventory or ender chest.
fn outputs_for(idx: &Index, dim: &str, b: &[i32; 6]) -> Vec<usize> {
    idx.containers.iter().filter(|c| c.dim == dim && !c.kind.starts_with("player:") && near(b, c.pos, 3)).map(|c| c.id).collect()
}

fn container_totals(idx: &Index, ids: &[usize]) -> HashMap<String, i64> {
    let mut m = HashMap::new();
    for id in ids {
        if let Some(c) = idx.containers.get(*id) {
            for (it, _) in mcworld::items::flatten(&c.items) {
                *m.entry(it.id.clone()).or_default() += it.count;
            }
        }
    }
    m
}

fn pos_key(p: &[i32; 3]) -> String {
    format!("{},{},{}", p[0], p[1], p[2])
}

pub fn report(ctx: &Ctx, assets: &Assets) -> Value {
    let u = user(ctx);
    let edits = u.get("edits").cloned().unwrap_or(json!({}));
    let idx = ctx.index.read().clone();
    let measured = read_json(&ctx.dir.join("companion-farms.json")).and_then(|v| v.get("farms").cloned()).unwrap_or(json!({}));
    let history = read_json(&ctx.dir.join("farms-history.json")).unwrap_or(json!({}));
    let mut farms = Vec::new();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut add = |f: Value, names: &mut HashMap<String, String>| {
        if let Some(m) = f.pointer("/rate/per_hour").and_then(|v| v.as_object()) {
            for k in m.keys() {
                names.entry(k.clone()).or_insert_with(|| assets.lang.name(k));
            }
        }
        farms.push(f);
    };
    let mut all: Vec<(Found, bool)> = detected(ctx).into_iter().map(|f| (f, false)).collect();
    for c in u.get("custom").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let b: Vec<i32> = c.get("box").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_i64().unwrap_or(0) as i32).collect()).unwrap_or_default();
        if b.len() != 6 {
            continue;
        }
        all.push((
            Found {
                id: c["id"].as_str().unwrap_or("custom").to_string(),
                kind: match c["kind"].as_str().unwrap_or("mob") {
                    "iron" => "iron",
                    "crop" => "crop",
                    "animal" => "animal",
                    "other" => "other",
                    _ => "mob",
                },
                sub: String::new(),
                name: c["name"].as_str().unwrap_or("Farm").to_string(),
                dim: Dim::from_id(c["dim"].as_str().unwrap_or("minecraft:overworld")).unwrap_or(Dim::Overworld),
                bbox: [b[0], b[1], b[2], b[3], b[4], b[5]],
                units: 1.0,
                auto: true,
                rules: vec![],
                why: vec!["Added by you".into()],
                confidence: "measured only",
            },
            true,
        ));
    }
    for (f, custom) in all {
        let e = edits.get(&f.id).cloned().unwrap_or(json!({}));
        if e.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let units = e.get("units").and_then(|v| v.as_f64()).unwrap_or(f.units);
        let scale = if f.units > 0.0 { units / f.units } else { 1.0 };
        let dim_id = f.dim.id().to_string();
        let outputs: Vec<usize> = if let Some(list) = e.get("outputs").and_then(|v| v.as_array()) {
            // stored as positions so they survive index rebuilds
            let want: HashSet<String> = list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
            idx.as_ref().map(|i| i.containers.iter().filter(|c| c.dim == dim_id && want.contains(&pos_key(&c.pos))).map(|c| c.id).collect()).unwrap_or_default()
        } else {
            idx.as_ref().map(|i| outputs_for(i, &dim_id, &f.bbox)).unwrap_or_default()
        };
        let rules: serde_json::Map<String, Value> = f.rules.iter().map(|(k, v)| (k.clone(), json!((v * scale).round()))).collect();
        let m = measured.get(&f.id).cloned();
        let m_minutes = m.as_ref().and_then(|m| m.get("minutes")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        // the real rate: the mod's measurement once it has 10+ minutes, else the rules
        let (per_hour, source) = if m_minutes >= 10.0 {
            (m.as_ref().and_then(|m| m.get("per_hour")).cloned().unwrap_or(json!({})), "measured")
        } else {
            (Value::Object(rules.clone()), if custom { "none yet" } else { "rules" })
        };
        let totals = idx.as_ref().map(|i| container_totals(i, &outputs)).unwrap_or_default();
        let out_list: Vec<Value> = idx
            .as_ref()
            .map(|i| outputs.iter().filter_map(|id| i.containers.get(*id)).map(|c| json!({ "id": c.id, "kind": c.kind, "pos": c.pos, "name": c.name })).collect())
            .unwrap_or_default();
        for k in totals.keys() {
            names.entry(k.clone()).or_insert_with(|| assets.lang.name(k));
        }
        add(
            json!({
                "id": f.id,
                "kind": e.get("kind").cloned().unwrap_or(json!(f.kind)),
                "sub": f.sub,
                "name": e.get("name").cloned().unwrap_or(json!(f.name)),
                "dim": dim_id,
                "box": f.bbox,
                "center": center(&f.bbox),
                "units": units,
                "auto": f.auto,
                "custom": custom,
                "why": f.why,
                "confidence": if f.confidence == "maybe" && e.get("confirmed").and_then(|v| v.as_bool()).unwrap_or(false) { "manual" } else { f.confidence },
                "maybe": f.confidence == "maybe" && !e.get("confirmed").and_then(|v| v.as_bool()).unwrap_or(false),
                "rate": { "per_hour": per_hour, "source": source, "rules": rules, "measured": m },
                "outputs": out_list,
                "stored": totals,
                "history": history.get(&f.id).cloned().unwrap_or(json!([])),
            }),
            &mut names,
        );
    }
    write_for_game(ctx, &farms);
    json!({ "farms": farms, "names": names, "t": now() })
}

/// longevity-farms.json for the companion mod's live measuring.
fn write_for_game(ctx: &Ctx, farms: &[Value]) {
    let list: Vec<Value> = farms
        .iter()
        .map(|f| {
            let outs: Vec<Value> = f["outputs"].as_array().cloned().unwrap_or_default().iter().map(|o| o["pos"].clone()).collect();
            json!({ "id": f["id"], "name": f["name"], "kind": f["kind"], "dim": f["dim"], "box": f["box"], "outputs": outs, "range": 128 })
        })
        .collect();
    let p = ctx.dir.join("longevity-farms.json");
    let new = json!({ "farms": list });
    // only rewrite when something changed, so the mod isn't re-reading for nothing
    let old = read_json(&p).and_then(|v| v.get("farms").cloned());
    if old.as_ref() != new.get("farms") {
        let mut v = new;
        v["t"] = json!(now());
        let _ = write_json(&p, &v);
    }
}

/// After each storage index build: record what's in each farm's output containers alongside the
/// play time, so the page can chart output over time and work out a real rate without the mod.
pub fn snapshot_outputs(ctx: &Ctx, idx: &Index) {
    let play_ticks = ctx
        .player_uuid
        .as_ref()
        .and_then(|u| ctx.world.stats_json(u))
        .and_then(|s| s.pointer("/stats/minecraft:custom/minecraft:play_time").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let u = user(ctx);
    let edits = u.get("edits").cloned().unwrap_or(json!({}));
    let p = ctx.dir.join("farms-history.json");
    let mut h = read_json(&p).unwrap_or(json!({}));
    let mut changed = false;
    for f in detected(ctx) {
        let dim_id = f.dim.id().to_string();
        let outputs: Vec<usize> = if let Some(list) = edits.get(&f.id).and_then(|e| e.get("outputs")).and_then(|v| v.as_array()) {
            let want: HashSet<String> = list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
            idx.containers.iter().filter(|c| c.dim == dim_id && want.contains(&pos_key(&c.pos))).map(|c| c.id).collect()
        } else {
            outputs_for(idx, &dim_id, &f.bbox)
        };
        if outputs.is_empty() {
            continue;
        }
        let totals = container_totals(idx, &outputs);
        let interesting: serde_json::Map<String, Value> = f.rules.iter().map(|(k, _)| (k.clone(), json!(totals.get(k).copied().unwrap_or(0)))).collect();
        let arr = h.as_object_mut().unwrap().entry(f.id.clone()).or_insert(json!([]));
        let list = arr.as_array_mut().unwrap();
        let last_play = list.last().and_then(|l| l["play"].as_i64()).unwrap_or(-1);
        if last_play == play_ticks {
            continue;
        }
        list.push(json!({ "t": now(), "play": play_ticks, "items": interesting }));
        if list.len() > 200 {
            list.remove(0);
        }
        changed = true;
    }
    if changed {
        let _ = write_json(&p, &h);
    }
}

pub fn save_user(ctx: &Ctx, farm: Value) -> R<Value> {
    let mut u = user(ctx);
    let id = farm.get("id").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| format!("custom-{}", now()));
    if farm.get("custom").and_then(|v| v.as_bool()).unwrap_or(false) {
        let list = u["custom"].as_array_mut().ok_or("bad farms.json")?;
        list.retain(|c| c["id"].as_str() != Some(id.as_str()));
        let mut c = farm.clone();
        c["id"] = json!(id);
        list.push(c);
    }
    // merge into what's there, so a rename doesn't forget "it's mine" or picked output chests
    let mut e = u["edits"].get(&id).cloned().filter(|v| v.is_object()).unwrap_or(json!({}));
    for k in ["name", "kind", "units", "outputs", "hidden", "confirmed"] {
        if let Some(v) = farm.get(k) {
            if !v.is_null() {
                e[k] = v.clone();
            }
        }
    }
    u["edits"][&id] = e;
    write_json(&user_path(ctx), &u)?;
    Ok(json!({ "id": id }))
}

pub fn delete_user(ctx: &Ctx, id: &str) -> R<()> {
    let mut u = user(ctx);
    if let Some(list) = u["custom"].as_array_mut() {
        let before = list.len();
        list.retain(|c| c["id"].as_str() != Some(id));
        if list.len() != before {
            if let Some(m) = u["edits"].as_object_mut() {
                m.remove(id);
            }
            return write_json(&user_path(ctx), &u);
        }
    }
    // a detected farm: hide it
    u["edits"][id]["hidden"] = json!(true);
    write_json(&user_path(ctx), &u)
}
