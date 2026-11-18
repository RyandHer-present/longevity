import * as THREE from "three";
import { SKY_VERT, SKY_FRAG, CLOUD_VERT, CLOUD_FRAG } from "./shaders";

const C = (hex: number) => new THREE.Color(hex);
const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));

export interface SkyState {
  sunDir: THREE.Vector3; // towards the dominant light (sun by day, moon by night)
  realSun: THREE.Vector3; // the sun itself, for the sky dome
  sunColor: THREE.Color;
  skyAmbient: THREE.Color;
  blockColor: THREE.Color;
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  minLight: THREE.Color;
  daylight: number;
  stars: number;
  nether: number;
  clouds: boolean;
}

/** Minecraft's celestial angle (0 = noon) for a day time in ticks. */
export function celestialAngle(dayTime: number): number {
  const t = (((dayTime % 24000) + 24000) % 24000) / 24000;
  const f = (((t - 0.25) % 1) + 1) % 1;
  return f + (1 - (Math.cos(f * Math.PI) + 1) / 2 - f) / 3;
}

export function skyState(dayTime: number, dim: string, rain: number, thunder: number): SkyState {
  if (dim.includes("nether")) {
    const fog = C(0x3a0d08);
    return {
      sunDir: new THREE.Vector3(0.3, 1, 0.2).normalize(),
      realSun: new THREE.Vector3(0, -1, 0),
      sunColor: C(0x000000),
      skyAmbient: C(0x000000),
      blockColor: C(0xffb070).multiplyScalar(1.15),
      zenith: C(0x2a0805),
      horizon: C(0x4a120a),
      fog,
      minLight: C(0x6a3a2c).multiplyScalar(0.5),
      daylight: 0,
      stars: 0,
      nether: 1,
      clouds: false,
    };
  }
  if (dim.includes("end")) {
    return {
      sunDir: new THREE.Vector3(0.25, 1, 0.35).normalize(),
      realSun: new THREE.Vector3(0, -1, 0),
      sunColor: C(0x6a5a80).multiplyScalar(0.6),
      skyAmbient: C(0x6a5d82).multiplyScalar(0.7),
      blockColor: C(0xffc080),
      zenith: C(0x07050c),
      horizon: C(0x1a1326),
      fog: C(0x120d1a),
      minLight: C(0x3a3050).multiplyScalar(0.4),
      daylight: 0.25,
      stars: 0.6,
      nether: 0.6,
      clouds: false,
    };
  }
  const a = celestialAngle(dayTime) * Math.PI * 2;
  const realSun = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0.22).normalize();
  const daylight = Math.min(1, Math.max(0, Math.cos(a) * 2 + 0.5)) * (1 - rain * 0.3);
  const h = realSun.y; // -1..1
  // sunset strength peaks when the sun is at the horizon
  const sunset = Math.max(0, 1 - Math.abs(h) / 0.32) * (1 - rain * 0.85);
  const dayZen = C(0x5f8fe8),
    dayHor = C(0xb9d3f5);
  const nightZen = C(0x03050b),
    nightHor = C(0x0a0f1d);
  let zenith = mix(nightZen, dayZen, daylight);
  let horizon = mix(nightHor, dayHor, daylight);
  horizon = mix(horizon, C(0xf08a4c), sunset * 0.75);
  zenith = mix(zenith, C(0x4a5fa8), sunset * 0.35);
  const grey = C(0x7d8794).multiplyScalar(Math.max(0.12, daylight));
  zenith = mix(zenith, grey, rain * 0.85);
  horizon = mix(horizon, grey.clone().multiplyScalar(1.1), rain * 0.85);
  if (thunder > 0) {
    zenith.multiplyScalar(1 - thunder * 0.4);
    horizon.multiplyScalar(1 - thunder * 0.4);
  }
  const moonUp = h < -0.05;
  const sunDir = moonUp ? realSun.clone().negate() : realSun.clone();
  const sunWarm = mix(C(0xffe9cf), C(0xff8c4a), sunset);
  const sunStrength = moonUp ? 0.12 : 2.2 * Math.min(1, Math.max(0, h * 3 + 0.15));
  const sunColor = moonUp ? C(0x8fa4d8).multiplyScalar(sunStrength * (1 - rain)) : sunWarm.multiplyScalar(sunStrength * (1 - rain * 0.85));
  const skyAmbient = mix(C(0x1a2236).multiplyScalar(0.55), C(0x9fb8e0).multiplyScalar(0.62), daylight);
  skyAmbient.lerp(C(0xc89070).multiplyScalar(0.55), sunset * 0.3);
  const fog = mix(horizon, zenith, 0.15);
  return {
    sunDir,
    realSun,
    sunColor,
    skyAmbient,
    blockColor: C(0xffbf80).multiplyScalar(1.25),
    zenith,
    horizon,
    fog,
    minLight: C(0x0a0c12).multiplyScalar(0.25),
    daylight,
    stars: Math.max(0, 1 - daylight * 1.6),
    nether: 0,
    clouds: true,
  };
}

export class SkyDome {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor(shared: Record<string, THREE.IUniform>) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { ...shared, uRealSun: { value: new THREE.Vector3(0, 1, 0) }, uStars: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }
}

export class Clouds {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  constructor(shared: Record<string, THREE.IUniform>, tex: THREE.Texture | null) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: { ...shared, uClouds: { value: tex }, uOffset: { value: new THREE.Vector2() } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const g = new THREE.PlaneGeometry(3200, 3200);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.position.y = 192.3;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = !!tex;
  }
  setTexture(t: THREE.Texture) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    this.mat.uniforms.uClouds.value = t;
    this.mesh.visible = true;
  }
  follow(cam: THREE.Vector3) {
    this.mesh.position.x = Math.round(cam.x / 12) * 12;
    this.mesh.position.z = Math.round(cam.z / 12) * 12;
  }
}
