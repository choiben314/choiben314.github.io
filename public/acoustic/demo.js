let trajectory = null;

function tubeFromPoints(points, radius, tubularSegments) {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.35);
  const segments = Math.max(tubularSegments ?? points.length * 4, 48);
  return new THREE.TubeGeometry(curve, segments, radius, 10, false);
}

function updateTube(mesh, points, radius, tubularSegments) {
  if (points.length < 2) {
    mesh.visible = false;
    return;
  }

  mesh.visible = true;
  mesh.geometry.dispose();
  mesh.geometry = tubeFromPoints(points, radius, tubularSegments);
}

async function init() {
  const res = await fetch("/acoustic/trajectory.json");
  trajectory = await res.json();
  setupScene();
}

function setupScene() {
  const container = document.getElementById("canvas-container");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x315c48);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.01,
    100,
  );
  camera.position.set(1.0, 0.8, 1.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 0, 0.25);
  controls.minDistance = 0.3;
  controls.maxDistance = 3;

  scene.add(new THREE.AmbientLight(0x4a6358, 0.65));
  const keyLight = new THREE.DirectionalLight(0xf7f1e6, 0.75);
  keyLight.position.set(2, 3, 2);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xd7ccbd, 0.35);
  fillLight.position.set(-2, 1, -1);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(0.6, 12, 0x4a7562, 0x2a5040);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = 0.001;
  scene.add(grid);

  const planeGeo = new THREE.CircleGeometry(0.28, 64);
  const planeMat = new THREE.MeshBasicMaterial({
    color: 0x2a5040,
    transparent: true,
    opacity: 0.55,
  });
  scene.add(new THREE.Mesh(planeGeo, planeMat));

  // Microphones
  const micGeo = new THREE.SphereGeometry(0.006, 16, 16);
  const micMat = new THREE.MeshStandardMaterial({
    color: 0xfff7df,
    emissive: 0xf7f1e6,
    emissiveIntensity: 0.35,
    metalness: 0.3,
    roughness: 0.55,
  });
  trajectory.mic_positions.forEach((pos) => {
    const mesh = new THREE.Mesh(micGeo, micMat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    scene.add(mesh);
  });

  // Full trajectory path
  const pathPoints = trajectory.trajectory.positions.map(
    (p) => new THREE.Vector3(p[0], p[1], p[2]),
  );
  const pathTube = new THREE.Mesh(
    tubeFromPoints(pathPoints, 0.0035, pathPoints.length * 3),
    new THREE.MeshBasicMaterial({
      color: 0xd7ccbd,
      transparent: true,
      opacity: 0.65,
    }),
  );
  scene.add(pathTube);

  // Playback progress along the trajectory
  const progressTube = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xe8c574,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  progressTube.visible = false;
  scene.add(progressTube);

  // Source
  const srcGeo = new THREE.SphereGeometry(0.018, 32, 32);
  const srcMat = new THREE.MeshStandardMaterial({
    color: 0xe8c574,
    emissive: 0xc9943a,
    emissiveIntensity: 0.65,
    metalness: 0.2,
    roughness: 0.4,
  });
  const sourceSphere = new THREE.Mesh(srcGeo, srcMat);
  scene.add(sourceSphere);

  // Beam cone
  const beamWidthRad = trajectory.beam_width_rad || 0.26;
  const coneHeight = 1.0;
  const coneRadius = coneHeight * Math.tan(beamWidthRad);
  const coneGeo = new THREE.ConeGeometry(coneRadius, coneHeight, 48, 1, true);
  const coneMat = new THREE.ShaderMaterial({
    uniforms: {
      color1: { value: new THREE.Color(0xe8c574) },
      color2: { value: new THREE.Color(0xc9943a) },
    },
    vertexShader: `varying float vHeight; varying float vRadius; void main() { vHeight = (-position.y / ${coneHeight.toFixed(2)}) + 0.5; vRadius = length(position.xz) / ${coneRadius.toFixed(4)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 color1; uniform vec3 color2; varying float vHeight; varying float vRadius; void main() { vec3 color = mix(color1, color2, vHeight * 0.5); float radialFade = 1.0 - smoothstep(0.0, 1.0, vRadius); float lengthFade = 1.0 - vHeight * 0.7; float alpha = 0.5 * radialFade * lengthFade; gl_FragColor = vec4(color, alpha); }`,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const beamCone = new THREE.Mesh(coneGeo, coneMat);
  scene.add(beamCone);

  const beamGlow = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xe8c574,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  beamGlow.visible = false;
  scene.add(beamGlow);

  // State
  let isPlaying = false,
    animationTime = 0,
    lastTimestamp = 0;

  const playBtn = document.getElementById("play-btn");
  const scrubber = document.getElementById("scrubber");
  const scrubberFill = document.getElementById("scrubber-fill");
  const scrubberHandle = document.getElementById("scrubber-handle");
  const timeDisplay = document.getElementById("time-display");

  function updateSource() {
    const positions = trajectory.trajectory.positions;
    const times = trajectory.trajectory.times;

    let frame = 0;
    for (let i = 0; i < times.length - 1; i++) {
      if (animationTime >= times[i] && animationTime < times[i + 1]) {
        frame = i;
        break;
      }
      if (animationTime >= times[times.length - 1]) {
        frame = times.length - 1;
      }
    }

    const t0 = times[frame],
      t1 = times[Math.min(frame + 1, times.length - 1)];
    const alpha = t1 > t0 ? Math.min(1, (animationTime - t0) / (t1 - t0)) : 0;
    const p0 = positions[frame],
      p1 = positions[Math.min(frame + 1, positions.length - 1)];

    const x = p0[0] + (p1[0] - p0[0]) * alpha;
    const y = p0[1] + (p1[1] - p0[1]) * alpha;
    const z = p0[2] + (p1[2] - p0[2]) * alpha;

    sourceSphere.position.set(x, y, z);

    // Update beam
    const dir = new THREE.Vector3(x, y, z);
    const distance = dir.length();
    if (distance >= 0.05) {
      dir.normalize();
      beamCone.scale.set(distance, distance, distance);
      const quaternion = new THREE.Quaternion();
      quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().negate(),
      );
      beamCone.quaternion.copy(quaternion);
      beamCone.position.set(
        dir.x * distance * 0.5,
        dir.y * distance * 0.5,
        dir.z * distance * 0.5,
      );
      beamGlow.geometry.dispose();
      updateTube(
        beamGlow,
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, y, z)],
        0.0018,
        16,
      );
    } else {
      beamGlow.visible = false;
    }

    const progressPoints = positions
      .slice(0, frame + 1)
      .map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const currentPoint = new THREE.Vector3(x, y, z);
    const lastPoint = progressPoints[progressPoints.length - 1];
    if (!lastPoint || lastPoint.distanceTo(currentPoint) > 0.0001) {
      progressPoints.push(currentPoint);
    }
    updateTube(progressTube, progressPoints, 0.0055, progressPoints.length * 4);

    // UI
    document.getElementById("pos-x").textContent = `x: ${x.toFixed(3)}`;
    document.getElementById("pos-y").textContent = `y: ${y.toFixed(3)}`;
    document.getElementById("pos-z").textContent = `z: ${z.toFixed(3)}`;
    document.getElementById("frame-display").textContent =
      `${frame + 1} / ${positions.length}`;
  }

  function updateUI() {
    const progress = (animationTime / trajectory.duration) * 100;
    scrubberFill.style.width = `${progress}%`;
    scrubberHandle.style.left = `${progress}%`;
    const formatTime = (s) => {
      const m = Math.floor(s / 60);
      return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
    };
    timeDisplay.textContent = `${formatTime(animationTime)} / ${formatTime(trajectory.duration)}`;
  }

  function animate(timestamp) {
    requestAnimationFrame(animate);
    if (isPlaying) {
      const delta = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 0;
      animationTime += delta;
      if (animationTime >= trajectory.duration) {
        animationTime = 0;
      }
      updateSource();
      updateUI();
    }
    lastTimestamp = timestamp;
    controls.update();
    renderer.render(scene, camera);
  }

  playBtn.addEventListener("click", () => {
    isPlaying = !isPlaying;
    playBtn.innerHTML = isPlaying
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
  });

  scrubber.addEventListener("click", (e) => {
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    animationTime = ratio * trajectory.duration;
    updateSource();
    updateUI();
  });

  window.addEventListener("resize", () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  updateSource();
  updateUI();
  animate();
}

init();
