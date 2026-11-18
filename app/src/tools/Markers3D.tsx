// Labels pinned to points in the 3D world. Positions are projected every frame and written straight
// to the DOM (no React re-render per frame), and markers behind the camera or far away fade out.
import { useEffect, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { Engine } from "../render/engine";

export interface Marker {
  key: string;
  pos: [number, number, number];
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  /** hide beyond this many blocks from the camera */
  range?: number;
}

export function Markers3D({ markers, className }: { markers: Marker[]; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const list = useRef(markers);
  list.current = markers;

  useEffect(() => {
    let raf = 0;
    const v = new THREE.Vector3();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const eng = Engine.get();
      const cam = eng.camera;
      const box = host.current?.getBoundingClientRect();
      if (!box || !box.width) return;
      for (const m of list.current) {
        const el = els.current.get(m.key);
        if (!el) continue;
        v.set(m.pos[0], m.pos[1], m.pos[2]);
        const d = cam.position.distanceTo(v);
        v.project(cam);
        const behind = v.z > 1 || v.z < -1;
        const far = d > (m.range ?? 140);
        if (behind || far) {
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
          continue;
        }
        const x = ((v.x + 1) / 2) * box.width;
        const y = ((1 - v.y) / 2) * box.height;
        const fade = Math.max(0.25, Math.min(1, 1.25 - d / (m.range ?? 140)));
        el.style.opacity = String(m.active ? 1 : fade);
        el.style.pointerEvents = "auto";
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${m.active ? 1.08 : Math.max(0.78, 1 - d / 400)})`;
        el.style.zIndex = String(m.active ? 100000 : Math.round(100000 - d * 10));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={"m3d " + (className ?? "")} ref={host}>
      {markers.map((m) => (
        <div
          key={m.key}
          className={"m3d-pin" + (m.active ? " on" : "")}
          ref={(el) => {
            if (el) els.current.set(m.key, el);
            else els.current.delete(m.key);
          }}
          onClick={(e) => {
            e.stopPropagation();
            m.onClick?.();
          }}
        >
          {m.children}
        </div>
      ))}
    </div>
  );
}

/** Attach the shared 3D engine to a box for the life of a component, looking at a point. */
export function useEngineView(host: React.RefObject<HTMLDivElement | null>, look: [number, number, number] | null, dist = 40, deps: unknown[] = []) {
  useEffect(() => {
    const eng = Engine.get();
    const el = host.current;
    if (!el) return;
    eng.attach(el);
    eng.setMode("orbit");
    eng.timeOverride = null;
    if (look) eng.lookAtPoint(look[0], look[1], look[2], dist);
    return () => {
      if (eng.container === el) eng.detach(el);
    };
  }, deps);
}
