override TILE:u32=64u;
struct Params { count:u32, dim:u32, cells:u32, mode:u32, radius:f32, strength:f32, damping:f32, pad:f32, leafBase:u32, level:u32, unused:vec2<u32> }
struct Particle { state:vec4<f32>, tags:vec4<u32> }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> input:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> species:array<u32>;
@group(0) @binding(4) var<uniform> curves:array<vec4<f32>,32>;
@group(0) @binding(5) var<storage,read_write> counts:array<atomic<u32>>;
// offsets[0..1023], tile descriptors[1024..], indirect dispatch in a separate buffer.
@group(0) @binding(6) var<storage,read_write> ranges:array<vec4<u32>>;
@group(0) @binding(7) var<storage,read_write> sorted:array<Particle>;
@group(0) @binding(8) var<storage,read_write> bounds:array<vec4<f32>>;
@group(1) @binding(0) var<storage,read_write> indirect:array<u32>;
var<workgroup> sharedRange:vec4<u32>;
var<workgroup> sharedBox:vec4<f32>;
var<workgroup> scan:array<u32,1024>;
var<workgroup> tileScan:array<u32,1024>;
var<workgroup> sourceTile:array<vec4<f32>,128>;
var<workgroup> boxTile:array<vec4<f32>,64>;
fn wrap(d:vec2<f32>)->vec2<f32>{return d-floor(d+vec2<f32>(.5));}
fn cell(pos:vec2<f32>)->u32{
 let xy=min(vec2<u32>(pos*f32(p.dim)),vec2<u32>(p.dim-1u));
 if(p.mode==0u){return xy.y*p.dim+xy.x;}
 var code=0u;for(var b=0u;b<5u;b++){code|=((xy.x>>b)&1u)<<(2u*b);code|=((xy.y>>b)&1u)<<(2u*b+1u);}return code;
}
fn force(delta:vec2<f32>,a:u32,b:u32)->vec2<f32>{
 let d2=dot(delta,delta);if(d2==0. || d2>=p.radius*p.radius){return vec2<f32>(0.);}
 let d=sqrt(d2);let r=d/p.radius;var value=0.;
 if(r<.08){value=-(1.-r/.08)*(1.-r/.08);}else{
 let c=curves[a*4u+b];var t=0.;var amp=0.;
 if(r<c.z){t=(r-.08)*c.w;amp=c.x;}else{t=(r-c.z)*curves[16u+a*4u+b].x;amp=c.y;}
 value=amp*16.*t*t*(1.-t)*(1.-t);}
 return delta*(value*p.strength/d);
}
fn integrate(q:Particle,a:vec2<f32>){let v=integrateVelocity(q.state.zw,a,p.damping,bitcast<f32>(p.unused.y));let pos=q.state.xy+v/60.;output[q.tags.y]=vec4<f32>(min(pos-floor(pos),vec2<f32>(.99999988)),v);}
@compute @workgroup_size(64) fn clear(@builtin(global_invocation_id) id:vec3<u32>){if(id.x<1024u){atomicStore(&counts[id.x],0u);}}
@compute @workgroup_size(64) fn histogram(@builtin(global_invocation_id) id:vec3<u32>){if(id.x<p.count){atomicAdd(&counts[cell(input[id.x].xy)],1u);}}
// Parallel exclusive scans. A single workgroup covers all supported cell counts.
@compute @workgroup_size(256) fn prefix(@builtin(local_invocation_index) lane:u32){
 for(var j=lane;j<1024u;j+=256u){let n=atomicLoad(&counts[j]);scan[j]=n;tileScan[j]=(n+TILE-1u)/TILE;}
 workgroupBarrier();
 for(var stride=1u;stride<1024u;stride*=2u){
  for(var j=(lane+1u)*stride*2u-1u;j<1024u;j+=256u*stride*2u){scan[j]+=scan[j-stride];tileScan[j]+=tileScan[j-stride];}workgroupBarrier();
 }
 if(lane==0u){atomicAdd(&counts[1024u],1u);indirect[0]=tileScan[1023];indirect[1]=1u;indirect[2]=1u;scan[1023]=0u;tileScan[1023]=0u;}workgroupBarrier();
 for(var stride=512u;stride>0u;stride/=2u){
  for(var j=(lane+1u)*stride*2u-1u;j<1024u;j+=256u*stride*2u){let a=scan[j-stride];scan[j-stride]=scan[j];scan[j]+=a;let b=tileScan[j-stride];tileScan[j-stride]=tileScan[j];tileScan[j]+=b;}workgroupBarrier();
 }
 for(var j=lane;j<1024u;j+=256u){let n=atomicLoad(&counts[j]);ranges[j]=vec4<u32>(scan[j],scan[j]+n,0u,0u);atomicStore(&counts[j],scan[j]);
  for(var k=0u;k<(n+TILE-1u)/TILE;k++){let start=scan[j]+k*TILE;ranges[1024u+tileScan[j]+k]=vec4<u32>(j,start,min(start+TILE,scan[j]+n),0u);}
 }
}
@compute @workgroup_size(64) fn scatter(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.count){return;}let c=cell(input[id.x].xy);let dst=atomicAdd(&counts[c],1u);sorted[dst]=Particle(input[id.x],vec4<u32>(species[id.x],id.x,c,0u));
}
@compute @workgroup_size(TILE) fn grid(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 if(lane==0u){sharedRange=ranges[1024u+group.x];}let tile=workgroupUniformLoad(&sharedRange);let index=tile.y+lane;let valid=index<tile.z;var q:Particle;if(valid){q=sorted[index];}var a=vec2<f32>(0.);
 let cx=i32(tile.x%p.dim);let cy=i32(tile.x/p.dim);let dim=i32(p.dim);
 for(var dy=-1;dy<=1;dy++){for(var dx=-1;dx<=1;dx++){
  let c=u32((cy+dy+dim)%dim)*p.dim+u32((cx+dx+dim)%dim);if(lane==0u){sharedRange=ranges[c];}let range=workgroupUniformLoad(&sharedRange);
  for(var base=range.x;base<range.y;base+=TILE){
   let j=base+lane;if(j<range.y){let s=sorted[j];sourceTile[lane]=vec4<f32>(s.state.xy,bitcast<f32>(s.tags.x),0.);}workgroupBarrier();
   if(valid){for(var k=0u;k<min(TILE,range.y-base);k++){let s=sourceTile[k];a+=force(wrap(s.xy-q.state.xy),q.tags.x,bitcast<u32>(s.z));}}workgroupBarrier();
  }
 }}if(valid){integrate(q,a);}
}
fn combine(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return vec4<f32>(min(a.xy,b.xy),max(a.zw,b.zw));}
@compute @workgroup_size(64) fn leafBounds(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 let i=group.x*64u+lane;var b=vec4<f32>(2.,2.,-1.,-1.);if(i<p.count){let pos=sorted[i].state.xy;b=vec4<f32>(pos,pos);}boxTile[lane]=b;workgroupBarrier();
 for(var stride=32u;stride>0u;stride/=2u){if(lane<stride){boxTile[lane]=combine(boxTile[lane],boxTile[lane+stride]);}workgroupBarrier();}
 if(lane==0u){bounds[p.leafBase+group.x]=boxTile[0];}
}
@compute @workgroup_size(64) fn reduceBounds(@builtin(global_invocation_id) id:vec3<u32>){if(id.x>=p.level){return;}let node=p.level+id.x;bounds[node]=combine(bounds[node*2u],bounds[node*2u+1u]);}
fn overlaps(a:vec4<f32>,b:vec4<f32>)->bool{
 if(any(b.xy>b.zw)){return false;}let halfA=(a.zw-a.xy)*.5;let halfB=(b.zw-b.xy)*.5;
 let delta=abs(wrap((a.xy+a.zw-b.xy-b.zw)*.5));let near=max(vec2<f32>(0.),delta-halfA-halfB);return dot(near,near)<p.radius*p.radius;
}
@compute @workgroup_size(64) fn bvh(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 let i=group.x*64u+lane;let valid=i<p.count;var q:Particle;if(valid){q=sorted[i];}var a=vec2<f32>(0.);if(lane==0u){sharedBox=bounds[p.leafBase+group.x];}let query=workgroupUniformLoad(&sharedBox);var node=1u;
 loop{if(node==0u){break;}if(lane==0u){sharedBox=bounds[node];}let box=workgroupUniformLoad(&sharedBox);
  if(overlaps(query,box)){
   if(node<p.leafBase){node*=2u;continue;}
   let base=(node-p.leafBase)*64u;let j=base+lane;if(j<p.count){let s=sorted[j];sourceTile[lane]=vec4<f32>(s.state.xy,bitcast<f32>(s.tags.x),0.);}workgroupBarrier();
   if(valid){for(var k=0u;k<min(64u,p.count-base);k++){let s=sourceTile[k];a+=force(wrap(s.xy-q.state.xy),q.tags.x,bitcast<u32>(s.z));}}workgroupBarrier();
  }
  // Stackless depth-first traversal of the compact balanced binary hierarchy.
  loop{if((node&1u)==0u || node==1u){break;}node/=2u;}if(node==1u){node=0u;}else{node+=1u;}
 }if(valid){integrate(q,a);}
}
@compute @workgroup_size(64) fn allPairs(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 let i=group.x*64u+lane;let valid=i<p.count;var q:Particle;if(valid){q=Particle(input[i],vec4<u32>(species[i],i,0u,0u));}var a=vec2<f32>(0.);
 for(var base=0u;base<p.count;base+=64u){let j=base+lane;if(j<p.count){sourceTile[lane]=vec4<f32>(input[j].xy,bitcast<f32>(species[j]),0.);}workgroupBarrier();
 if(valid){for(var k=0u;k<min(64u,p.count-base);k++){let s=sourceTile[k];a+=force(wrap(s.xy-q.state.xy),q.tags.x,bitcast<u32>(s.z));}}workgroupBarrier();}
 if(valid){integrate(q,a);}
}

fn hash(x:u32)->u32{var v=x;v=(v^(v>>16u))*0x7feb352du;v=(v^(v>>15u))*0x846ca68bu;return v^(v>>16u);}
// Rotated stratified sampling bounds pair work. The estimator is explicitly approximate.
@compute @workgroup_size(64) fn sampled(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.count){return;}let q=sorted[id.x];let cx=i32(q.tags.z%p.dim);let cy=i32(q.tags.z/p.dim);let dim=i32(p.dim);
 var cells:array<vec2<u32>,9>;var total=0u;var index=0u;
 for(var dy=-1;dy<=1;dy++){for(var dx=-1;dx<=1;dx++){let c=u32((cy+dy+dim)%dim)*p.dim+u32((cx+dx+dim)%dim);let r=ranges[c];cells[index]=r.xy;total+=r.y-r.x;index++;}}
 let samples=min(total,p.unused.x);let tick=atomicLoad(&counts[1024u]);let shift=hash(q.tags.y^bitcast<u32>(p.pad)^hash(tick))%max(total,1u);var a=vec2<f32>(0.);
 for(var k=0u;k<samples;k++){
  var slot=k;if(samples<total){slot=(u32((f32(k)+.5)*f32(total)/f32(samples))+shift)%total;}
  var source=0u;for(var cellIndex=0u;cellIndex<9u;cellIndex++){let r=cells[cellIndex];let n=r.y-r.x;if(slot<n){source=r.x+slot;break;}slot-=n;}
  let s=sorted[source];a+=force(wrap(s.state.xy-q.state.xy),q.tags.x,s.tags.x);
 }
 if(samples>0u){a*=f32(total)/f32(samples);}integrate(q,a);
}

