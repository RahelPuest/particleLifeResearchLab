struct Params { count:u32, dim:u32, coreDim:u32, pad:u32, radius:f32, strength:f32, damping:f32, maximum:f32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> input:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> species:array<u32>;
@group(0) @binding(4) var<uniform> curves:array<vec4<f32>,32>;
@group(0) @binding(5) var<storage,read_write> density:array<atomic<u32>>;
@group(0) @binding(6) var<storage,read_write> heads:array<atomic<u32>>;
@group(0) @binding(7) var<storage,read_write> links:array<u32>;
@group(0) @binding(8) var<storage,read_write> spectrum:array<vec4<f32>>;
@group(0) @binding(9) var<storage,read_write> kernels:array<vec4<f32>>;
@group(0) @binding(10) var<storage,read_write> field:array<vec4<f32>>;
@group(0) @binding(11) var<storage,read> composition:array<vec4<f32>>;
@group(0) @binding(12) var<storage,read_write> nextComposition:array<vec4<f32>>;
@group(0) @binding(13) var<storage,read_write> environment:array<vec4<f32>>;
struct Reactions { settings:vec4<f32>, rules:array<vec4<f32>,8> }
@group(0) @binding(14) var<uniform> reactions:Reactions;
fn splitMass(mass:u32, mix:vec4<f32>)->vec4<u32>{
 var result=vec4<u32>(floor(f32(mass)*mix));var largest=0u;
 for(var k=1u;k<4u;k++){if(mix[k]>mix[largest]){largest=k;}}
 // Keep absent species exactly absent; put quantization residue in an existing component.
 result[largest]+=mass-result.x-result.y-result.z-result.w;return result;
}
const MASS:f32=16384.; // At 50,000 particles even a single occupied node cannot overflow u32.
fn wrap(d:vec2<f32>)->vec2<f32>{return d-floor(d+vec2<f32>(.5));}
fn node(xy:vec2<u32>)->u32{return (xy.y%p.dim)*p.dim+xy.x%p.dim;}
fn weights(pos:vec2<f32>)->vec4<u32>{
  let f=fract(pos*f32(p.dim));
  let w=vec3<u32>(floor(vec3<f32>((1.-f.x)*(1.-f.y),f.x*(1.-f.y),(1.-f.x)*f.y)*MASS));
  return vec4<u32>(w,16384u-w.x-w.y-w.z);
}
@compute @workgroup_size(64) fn clear(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x<4u*p.dim*p.dim){atomicStore(&density[id.x],0u);}
  if(id.x<p.coreDim*p.coreDim){atomicStore(&heads[id.x],0u);}
}
@compute @workgroup_size(64) fn deposit(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x>=p.count){return;}
  let pos=input[id.x].xy;let xy=vec2<u32>(pos*f32(p.dim));let w=weights(pos);var mix=vec4<f32>(0.);mix[species[id.x]]=1.;if(p.pad==1u){mix=composition[id.x];}
  let nodes=array<u32,4>(node(xy),node(xy+vec2<u32>(1u,0u)),node(xy+vec2<u32>(0u,1u)),node(xy+vec2<u32>(1u,1u)));
  for(var corner=0u;corner<4u;corner++){let masses=splitMass(w[corner],mix);
    for(var kind=0u;kind<4u;kind++){if(masses[kind]>0u){atomicAdd(&density[kind*p.dim*p.dim+nodes[corner]],masses[kind]);}}
  }
  let cell=min(vec2<u32>(pos*f32(p.coreDim)),vec2<u32>(p.coreDim-1u));
  links[id.x]=atomicExchange(&heads[cell.y*p.coreDim+cell.x],id.x+1u);
}
@compute @workgroup_size(64) fn densityInput(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x<4u*p.dim*p.dim){spectrum[id.x]=vec4<f32>(f32(atomicLoad(&density[id.x]))/MASS,0.,0.,0.);}
}
// Convolution uses receiver-minus-source offsets, so reverse the physical force direction.
// Only the outer kernel lives on the mesh. The collision core is added directly below.
@compute @workgroup_size(64) fn kernelInput(@builtin(global_invocation_id) id:vec3<u32>){
  let cells=p.dim*p.dim;if(id.x>=17u*cells){return;}
  let pair=id.x/cells;let index=id.x%cells;
  let delta=-wrap(vec2<f32>(f32(index%p.dim),f32(index/p.dim))/f32(p.dim));
  let d=length(delta);let r=d/p.radius;var value=0.;
  if(pair==16u){kernels[id.x]=vec4<f32>(max(0.,1.-r)*max(0.,1.-r),0.,0.,0.);return;}
  if(r>=.08 && r<1.) {
    let c=curves[pair];var t=0.;var amplitude=0.;
    if(r<c.z){t=(r-.08)*c.w;amplitude=c.x;}else{t=(r-c.z)*curves[16u+pair].x;amplitude=c.y;}
    value=amplitude*16.*t*t*(1.-t)*(1.-t)/d;
  }
  kernels[id.x]=vec4<f32>(delta.x*value,0.,delta.y*value,0.);
}
fn multiply(a:vec2<f32>,b:vec2<f32>)->vec2<f32>{return vec2<f32>(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
@compute @workgroup_size(64) fn convolve(@builtin(global_invocation_id) id:vec3<u32>){
  let cells=p.dim*p.dim;if(id.x>=4u*cells){return;}
  let receiver=id.x/cells;let index=id.x%cells;var sum=vec4<f32>(0.);
  for(var source=0u;source<4u;source++){
    let rho=spectrum[source*cells+index].xy;let kernel=kernels[(receiver*4u+source)*cells+index];
    sum+=vec4<f32>(multiply(rho,kernel.xy),multiply(rho,kernel.zw));
  }
  field[id.x]=sum;
}
fn readField(xy:vec2<u32>,kind:u32)->vec2<f32>{return field[kind*p.dim*p.dim+node(xy)].xz;}
@compute @workgroup_size(64) fn advance(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x>=p.count){return;}let q=input[id.x];let xy=vec2<u32>(q.xy*f32(p.dim));let w=vec4<f32>(weights(q.xy))/MASS;let kind=species[id.x];
  var force=vec2<f32>(0.);var mix=vec4<f32>(0.);mix[kind]=1.;if(p.pad==1u){mix=composition[id.x];}
  for(var k=0u;k<4u;k++){if(mix[k]>0.){force+=mix[k]*(readField(xy,k)*w.x+readField(xy+vec2<u32>(1u,0u),k)*w.y+readField(xy+vec2<u32>(0u,1u),k)*w.z+readField(xy+vec2<u32>(1u,1u),k)*w.w);}}
  let dim=i32(p.coreDim);let cell=vec2<i32>(q.xy*f32(dim));let radius=p.radius*.08;
  for(var dy=-1;dy<=1;dy++){for(var dx=-1;dx<=1;dx++){
    let index=u32((cell.y+dy+dim)%dim)*p.coreDim+u32((cell.x+dx+dim)%dim);
    var next=atomicLoad(&heads[index]);
    loop {
      if(next==0u){break;}let j=next-1u;next=links[j];
      let delta=wrap(input[j].xy-q.xy);let d2=dot(delta,delta);
      if(d2>0. && d2<radius*radius){let d=sqrt(d2);let f=1.-d/radius;force-=delta*(f*f/d);}
    }
  }}
  let velocity=integrateVelocity(q.zw,force*p.strength,p.damping,p.maximum);
  let pos=q.xy+velocity/60.;output[id.x]=vec4<f32>(min(pos-floor(pos),vec2<f32>(.99999988)),velocity);
}

@compute @workgroup_size(64) fn convolveEnvironment(@builtin(global_invocation_id) id:vec3<u32>){
 let cells=p.dim*p.dim;if(id.x>=4u*cells){return;}
 environment[id.x]=vec4<f32>(multiply(spectrum[id.x].xy,kernels[16u*cells+id.x%cells].xy),0.,0.);
}
@compute @workgroup_size(64) fn react(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.count){return;}let pos=input[id.x].xy;let xy=vec2<u32>(pos*f32(p.dim));let w=weights(pos);let mix=composition[id.x];
 let offsets=array<vec2<u32>,4>(vec2<u32>(0u,0u),vec2<u32>(1u,0u),vec2<u32>(0u,1u),vec2<u32>(1u,1u));
 var env=vec4<f32>(0.);
 for(var a=0u;a<4u;a++){
   let factor=f32(w[a])/MASS;
   for(var k=0u;k<4u;k++){env[k]+=factor*environment[k*p.dim*p.dim+node(xy+offsets[a])].x;}
   // Remove the same quantized CIC self contribution used by the deposition pass.
   for(var b=0u;b<4u;b++){
     let delta=(vec2<f32>(offsets[a])-vec2<f32>(offsets[b]))/f32(p.dim);
     let h=max(0.,1.-length(delta)/p.radius);
     env-=factor*h*h*vec4<f32>(splitMass(w[b],mix))/MASS;
   }
 }
 env=max(env,vec4<f32>(0.));
 var outgoing=vec4<f32>(0.);var rates:array<f32,8>;
 let count=u32(reactions.settings.x);
 for(var i=0u;i<count;i++){
   let r=reactions.rules[i];var activation=1.;
   if(r.z>=0.){let e=env[u32(r.z)];activation=e/(1.+e);}
   let rate=r.w*reactions.settings.y*activation;rates[i]=rate;outgoing[u32(r.x)]+=rate;
 }
 var result=mix;
 for(var i=0u;i<count;i++){
   let r=reactions.rules[i];let sourceType=u32(r.x);let targetType=u32(r.y);let sum=outgoing[sourceType];
   if(sum>0.){let amount=mix[sourceType]*(1.-exp(-sum/60.))*rates[i]/sum;result[sourceType]-=amount;result[targetType]+=amount;}
 }
 result=max(result,vec4<f32>(0.));nextComposition[id.x]=result/dot(result,vec4<f32>(1.));
}
