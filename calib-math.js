// Focal length from planar views, without OpenCV (fallback and cross-check).
// Model: principal point = image centre, fx = fy = f, zero distortion.
// 1) Per view, a homography H maps board-plane (X, Y) to image (u, v).
// 2) With the principal point moved to the origin, H' = T H, the columns h1, h2 of K^-1 H'
//    are orthogonal and of equal length (Zhang 2000). With K = diag(f, f, 1) and w = 1/f^2:
//      (h11 h12 + h21 h22) w + h31 h32 = 0
//      (h11^2 + h21^2 - h12^2 - h22^2) w + (h31^2 - h32^2) = 0
//    Least squares over all views gives w, hence f = 1/sqrt(w).
// 3) Refine f by minimising the reprojection error (per-view pose by Gauss-Newton).

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => Math.hypot(a[0], a[1], a[2]);

// Smallest-eigenvalue eigenvector of a symmetric matrix (cyclic Jacobi).
function smallestEigenvector(S) {
  const n = S.length, A = S.map(r => [...r]), V = A.map((_, i) => A.map((_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (A[i][i] < A[best][best]) best = i;
  return V.map(r => r[best]);
}

function normaliser(pts) {
  const m = [0, 0];
  for (const p of pts) { m[0] += p[0] / pts.length; m[1] += p[1] / pts.length; }
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - m[0], p[1] - m[1]) / pts.length;
  const s = Math.SQRT2 / (d || 1);
  return { T: [[s, 0, -s * m[0]], [0, s, -s * m[1]], [0, 0, 1]], Ti: [[1 / s, 0, m[0]], [0, 1 / s, m[1]], [0, 0, 1]] };
}
const apply = (T, p) => [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2], T[1][0] * p[0] + T[1][1] * p[1] + T[1][2]];
const mul3 = (A, B) => A.map((r, i) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));

// Normalised DLT homography: img ~ H [X, Y, 1]
export function homography(obj, img) {
  const no = normaliser(obj), ni = normaliser(img), S = Array.from({ length: 9 }, () => Array(9).fill(0));
  for (let k = 0; k < obj.length; k++) {
    const [X, Y] = apply(no.T, obj[k]), [u, v] = apply(ni.T, img[k]);
    for (const r of [[X, Y, 1, 0, 0, 0, -u * X, -u * Y, -u], [0, 0, 0, X, Y, 1, -v * X, -v * Y, -v]])
      for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) S[i][j] += r[i] * r[j];
  }
  const h = smallestEigenvector(S), Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
  return mul3(mul3(ni.Ti, Hn), no.T);
}

// Closed-form f from the homographies (principal point fixed at (cx, cy)).
export function closedFormFocal(Hs, cx, cy) {
  let num = 0, den = 0;
  for (const H of Hs) {
    const P = mul3([[1, 0, -cx], [0, 1, -cy], [0, 0, 1]], H);
    const s = Math.hypot(...P.flat());
    const h = P.map(r => r.map(x => x / s));
    const eqs = [
      [h[0][0] * h[0][1] + h[1][0] * h[1][1], h[2][0] * h[2][1]],
      [h[0][0] ** 2 + h[1][0] ** 2 - h[0][1] ** 2 - h[1][1] ** 2, h[2][0] ** 2 - h[2][1] ** 2],
    ];
    for (const [a, b] of eqs) { num += a * b; den += a * a; }
  }
  const w = -num / den;
  return w > 0 ? 1 / Math.sqrt(w) : null;
}

function rodrigues(r) {
  const th = norm3(r);
  if (th < 1e-12) return [[1, -r[2], r[1]], [r[2], 1, -r[0]], [-r[1], r[0], 1]];
  const k = r.map(x => x / th), c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
    [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
    [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
  ];
}
function rotToVec(R) {
  const c = Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)), th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  const s = 2 * Math.sin(th);
  return [(R[2][1] - R[1][2]) / s * th, (R[0][2] - R[2][0]) / s * th, (R[1][0] - R[0][1]) / s * th];
}
// Nearest rotation to M by repeated averaging with the inverse transpose (polar decomposition).
function nearestRotation(M) {
  let R = M.map(r => [...r]);
  for (let it = 0; it < 30; it++) {
    const [a, b, c] = R, det = dot3(a, cross3(b, c));
    const invT = [cross3(b, c), cross3(c, a), cross3(a, b)].map(r => r.map(x => x / det));
    R = R.map((r, i) => r.map((x, j) => 0.5 * (x + invT[i][j])));
  }
  return R;
}

// Initial pose of a view from its homography for a given f.
function poseFromHomography(H, f, cx, cy) {
  const P = mul3([[1 / f, 0, -cx / f], [0, 1 / f, -cy / f], [0, 0, 1]], H);
  const c1 = [P[0][0], P[1][0], P[2][0]], c2 = [P[0][1], P[1][1], P[2][1]], c3 = [P[0][2], P[1][2], P[2][2]];
  let l = 2 / (norm3(c1) + norm3(c2));
  if (c3[2] * l < 0) l = -l;   // board in front of the camera
  const r1 = c1.map(x => x * l), r2 = c2.map(x => x * l), M = [0, 1, 2].map(i => [r1[i], r2[i], cross3(r1, r2)[i]]);
  return { r: rotToVec(nearestRotation(M)), t: c3.map(x => x * l) };
}

function project(r, t, f, cx, cy, X, Y) {
  const R = rodrigues(r);
  const x = R[0][0] * X + R[0][1] * Y + t[0], y = R[1][0] * X + R[1][1] * Y + t[1], z = R[2][0] * X + R[2][1] * Y + t[2];
  return [f * x / z + cx, f * y / z + cy];
}
function viewResiduals(p, f, cx, cy, view) {
  const out = [];
  for (let k = 0; k < view.obj.length; k++) {
    const q = project(p.slice(0, 3), p.slice(3), f, cx, cy, view.obj[k][0], view.obj[k][1]);
    out.push(q[0] - view.img[k][0], q[1] - view.img[k][1]);
  }
  return out;
}
// Solve a small dense system A x = b (Gaussian elimination with partial pivoting).
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-18) return null;
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
  return x;
}
// Gauss-Newton (with Levenberg damping) on one view's 6 pose parameters.
function refinePose(p0, f, cx, cy, view) {
  let p = [...p0], e = viewResiduals(p, f, cx, cy, view), cost = e.reduce((s, x) => s + x * x, 0), lambda = 1e-3;
  for (let it = 0; it < 20; it++) {
    const J = e.map(() => Array(6).fill(0));
    for (let j = 0; j < 6; j++) {
      const h = j < 3 ? 1e-6 : 1e-7, q = [...p]; q[j] += h;
      const e2 = viewResiduals(q, f, cx, cy, view);
      for (let i = 0; i < e.length; i++) J[i][j] = (e2[i] - e[i]) / h;
    }
    const JtJ = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => J.reduce((s, r) => s + r[a] * r[b], 0)));
    const Jte = Array.from({ length: 6 }, (_, a) => J.reduce((s, r, i) => s + r[a] * e[i], 0));
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const d = solve(JtJ.map((r, i) => r.map((x, j) => x + (i === j ? lambda * (x || 1) : 0))), Jte.map(x => -x));
      if (!d) break;
      const q = p.map((x, i) => x + d[i]), e2 = viewResiduals(q, f, cx, cy, view), c2 = e2.reduce((s, x) => s + x * x, 0);
      if (c2 < cost) { p = q; e = e2; improved = cost - c2 > 1e-12 * cost ? true : 'stop'; cost = c2; lambda = Math.max(lambda / 10, 1e-9); }
      else lambda *= 10;
    }
    if (improved !== true) break;
  }
  return { p, cost };
}
function totalCost(f, cx, cy, views, Hs) {
  let cost = 0, n = 0;
  for (let i = 0; i < views.length; i++) {
    const init = poseFromHomography(Hs[i], f, cx, cy);
    cost += refinePose([...init.r, ...init.t], f, cx, cy, views[i]).cost;
    n += views[i].obj.length;
  }
  return { cost, rms: Math.sqrt(cost / n) };
}

// views: [{obj: [[X, Y], ...] (board plane, any unit), img: [[u, v], ...] (px)}]
export function estimateFocal(views, width, height) {
  const cx = width / 2, cy = height / 2;
  const Hs = views.map(v => homography(v.obj, v.img));
  const f0 = closedFormFocal(Hs, cx, cy);
  if (!f0) return null;
  // Golden-section search for f around the closed-form value.
  let a = 0.8 * f0, b = 1.25 * f0;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = totalCost(c, cx, cy, views, Hs).cost, fd = totalCost(d, cx, cy, views, Hs).cost;
  while (b - a > 1e-4 * f0) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = totalCost(c, cx, cy, views, Hs).cost; }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = totalCost(d, cx, cy, views, Hs).cost; }
  }
  const f = (a + b) / 2;
  return { f, fClosedForm: f0, rms: totalCost(f, cx, cy, views, Hs).rms };
}

// Board-pose features used to decide whether a new frame adds information.
export function viewPose(obj, img, f, width, height) {
  const H = homography(obj, img), pose = poseFromHomography(H, f, width / 2, height / 2);
  const R = rodrigues(pose.r), tilt = Math.acos(Math.min(1, Math.abs(R[2][2]))) * 180 / Math.PI;
  return { R, t: pose.t, tiltDeg: tilt };
}
export function rotationAngleDeg(R1, R2) {
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += R1[k][i] * R2[k][i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI;
}
