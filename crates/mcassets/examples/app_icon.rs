use image::{Rgba, RgbaImage};
fn rounded(size: u32, top: [u8; 3], bottom: [u8; 3], ring: [u8; 3]) -> RgbaImage {
    let mut img = RgbaImage::new(size, size);
    let r = size as f32 * 0.22;
    for y in 0..size {
        for x in 0..size {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let cx = fx.clamp(r, size as f32 - r);
            let cy = fy.clamp(r, size as f32 - r);
            let d = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
            let a = (r - d + 0.5).clamp(0.0, 1.0);
            if a <= 0.0 { continue; }
            let t = fy / size as f32;
            let mut c = [0f32; 3];
            for k in 0..3 { c[k] = top[k] as f32 * (1.0 - t) + bottom[k] as f32 * t; }
            // soft inner ring
            let edge = (r - d).min(fx.min(fy).min(size as f32 - fx).min(size as f32 - fy));
            if edge < size as f32 * 0.03 { for k in 0..3 { c[k] = c[k] * 0.6 + ring[k] as f32 * 0.4; } }
            img.put_pixel(x, y, Rgba([c[0] as u8, c[1] as u8, c[2] as u8, (a * 255.0) as u8]));
        }
    }
    img
}
fn main() -> anyhow::Result<()> {
    let a = mcassets::Assets::discover("26.3")?;
    let out = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    for (name, block, top, bottom, ring) in [
        ("atlas", "grass_block", [28u8, 40, 58], [12u8, 16, 24], [214u8, 176, 98]),
        ("worlds", "moss_block", [54u8, 34, 82], [18u8, 12, 30], [170u8, 140, 255]),
    ] {
        let mut bg = rounded(1024, top, bottom, ring);
        let ic = mcassets::icons::item_icon(&a, block, 640).unwrap();
        image::imageops::overlay(&mut bg, &ic, 192, 176);
        bg.save(out.join(format!("{name}-icon.png")))?;
    }
    Ok(())
}
