export const rad = x => x*Math.PI/180;
export const deg = x => x*180/Math.PI;
export const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
export const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
export const median = a => { const b=[...a].sort((x,y)=>x-y);const n=b.length;return n ? (b[(n-1)>>1]+b[n>>1])/2 : null; };
export const sd = a => { const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2))); };
const unit = v => {const n=Math.hypot(...v);return n>1e-8?v.map(x=>x/n):null;};

export function faceRotation(matrix) {
  if (!matrix || matrix.data?.length !== 16) return null;
  const m=Array.from(matrix.data);
  // Same layout check as the reference demo; retain the layout in exported data.
  const columnMajor=Math.abs(m[12])+Math.abs(m[13])+Math.abs(m[14])>=Math.abs(m[3])+Math.abs(m[7])+Math.abs(m[11]);
  const at=(i,j)=>columnMajor?m[4*j+i]:m[4*i+j];
  const cols=[0,1,2].map(j=>unit([at(0,j),at(1,j),at(2,j)]));
  if(cols.some(c=>!c))return null;
  const R=(i,j)=>cols[j][i];
  return {pitch:deg(Math.atan2(R(2,1),R(2,2))),yaw:-deg(Math.asin(clamp(-R(2,0),-1,1))),roll:deg(Math.atan2(R(1,0),R(0,0))),normal:cols[2],matrix:m,columnMajor};
}

// Portrait only. DeviceOrientation uses Rz(alpha) Rx(beta) Ry(gamma).
// Earth's up expressed in device axes is the third row of that rotation.
// Alpha is unnecessary for inclination relative to gravity.
export function upFromOrientation(o) {
  if(!o || !Number.isFinite(o.beta) || !Number.isFinite(o.gamma))return null;
  const b=rad(o.beta),g=rad(o.gamma);
  return [-Math.cos(b)*Math.sin(g),Math.sin(b),Math.cos(b)*Math.cos(g)];
}

export function headInclination(pose,o) {
  const up=upFromOrientation(o);
  if(!pose||!up)return null;
  // Unmirrored front-camera geometry -> device axes: rotate 180° about y.
  // CSS mirror affects display only. Actual device axis correspondence needs
  // physical validation; never infer neck translation or CVA from this alone.
  const n=pose.normal;const forward=[-n[0],n[1],-n[2]];
  return -deg(Math.asin(clamp(forward.reduce((s,x,i)=>s+x*up[i],0),-1,1)));
}

export function measureIris(lm,w,h) {
  if(!lm||lm.length<478)return null;
  const px=i=>[lm[i].x*w,lm[i].y*h];
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const diameter=c=>Math.max(dist(px(c+1),px(c+3)),dist(px(c+2),px(c+4)));
  const right=diameter(468),left=diameter(473),p=(right+left)/2;
  const center=[(lm[468].x+lm[473].x)/2,(lm[468].y+lm[473].y)/2];
  const eyeOpen=(a,b,c,d)=>dist(px(a),px(b))/Math.max(1,dist(px(c),px(d)));
  const open=Math.min(eyeOpen(159,145,33,133),eyeOpen(386,374,362,263));
  const valid=Number.isFinite(p)&&p>=5&&Math.min(left,right)/Math.max(left,right)>.65&&open>.12&&[468,473,469,470,471,472,474,475,476,477].every(i=>lm[i].x>0&&lm[i].x<1&&lm[i].y>0&&lm[i].y<1);
  return {left,right,p,center,open,valid};
}
