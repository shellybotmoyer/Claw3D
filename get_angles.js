async function main() {
  const THREE = await import("three");
  const target = new THREE.Vector3(0, 0, 1);
  const v = new THREE.Vector3(-0.42, 1.32, -1.47).normalize();

  // We want to find a rotation of the earth group (with order XYZ or YXZ).
  // that brings v to target.
  // But the earth might have arbitrary rotations.
  // we want to rotate earth such that earth.localToWorld(v) == target.
  // so earth.quaternion * v = target.
  // earth.quaternion = quaternion that rotates v to target.
  const q = new THREE.Quaternion().setFromUnitVectors(v, target);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  void e;

  const cameraDir = new THREE.Vector3(0, 0.8 - 0.5, -0.5 - 2.05).normalize().negate();
  void cameraDir;
}

void main();

