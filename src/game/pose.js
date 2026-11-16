// Smooth visual pose for any car mesh: interpolated position/heading, road
// tilt slerped (the track normal changes in steps between samples) and ride
// height damped. Heading is never smoothed, so cars stay crisp.
import * as THREE from 'three';
import { damp } from '../core/math.js';

const Y = new THREE.Vector3(0, 1, 0);
const n = new THREE.Vector3(), qa = new THREE.Quaternion(), qh = new THREE.Quaternion(), qt = new THREE.Quaternion();

export class CarPoser {
  constructor() { this.tilt = new THREE.Quaternion(); this.y = null; }

  /** Place `mesh` at (x, z, heading) on the track surface. */
  apply(mesh, track, x, z, heading, hint, dt, snap = false) {
    const q = track.query(x, z, hint);
    n.set(q.normal[0], q.normal[1], q.normal[2]);
    qa.setFromUnitVectors(Y, n); // target tilt
    if (snap || this.y == null) { this.tilt.copy(qa); this.y = q.height; }
    else {
      this.tilt.slerp(qa, damp(14, dt));
      this.y += (q.height - this.y) * damp(26, dt);
      if (Math.abs(q.height - this.y) > 0.6) this.y = q.height;
    }
    qh.setFromAxisAngle(Y, heading);
    mesh.position.set(x, this.y, z);
    mesh.quaternion.copy(qt.copy(this.tilt).multiply(qh));
    return q;
  }
}
