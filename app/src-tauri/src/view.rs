//! Adapter that lets the mesher read a set of loaded chunks. Chunks the player hasn't seen are
//! presented as solid stone so their contents (caves, ores) never show up at the edge.

use blockdata::{BlockSource, BlockState, Section};
use mcworld::Chunk;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

pub struct View {
    pub chunks: HashMap<(i32, i32), Arc<Chunk>>,
    /// Hidden chunks with the highest surface Y they have (filled with stone up to there).
    pub hidden: HashMap<(i32, i32), i32>,
    pub range: (i32, i32),
    /// Sections with view-only changes (open doors, hidden chests), by (cx, sy, cz).
    pub patched: HashMap<(i32, i32, i32), Section>,
}

fn stone() -> &'static Section {
    static S: OnceLock<Section> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = Section::empty();
        s.palette = vec![BlockState::new("stone")];
        s.data = vec![0; 4096];
        s
    })
}

impl BlockSource for View {
    fn section(&self, cx: i32, sy: i32, cz: i32) -> Option<&Section> {
        if let Some(s) = self.patched.get(&(cx, sy, cz)) {
            return Some(s);
        }
        if let Some(top) = self.hidden.get(&(cx, cz)) {
            // sealed up to its surface; open air above
            return if sy * 16 <= *top { Some(stone()) } else { None };
        }
        self.chunks.get(&(cx, cz))?.section(sy)
    }
    fn section_range(&self) -> (i32, i32) {
        self.range
    }
}

impl mesher::MeshSource for View {
    fn light(&self, cx: i32, sy: i32, cz: i32) -> (Option<&[u8]>, Option<&[u8]>) {
        if self.hidden.contains_key(&(cx, cz)) {
            return (None, None);
        }
        match self.chunks.get(&(cx, cz)).and_then(|c| c.light(sy)) {
            Some(l) => (l.sky.as_deref(), l.block.as_deref()),
            None => (None, None),
        }
    }
}
