struct Params {
  count:u32, depth:u32, firstLeaf:u32, leafCount:u32,
  nodeCount:u32, levelStart:u32, levelCount:u32, pad:u32,
  radius:f32, strength:f32, damping:f32, theta:f32,
}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> inputParticles:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> outputParticles:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> species:array<u32>;
@group(0) @binding(4) var<storage,read_write> heads:array<atomic<i32>>;
@group(0) @binding(5) var<storage,read_write> links:array<i32>;
@group(0) @binding(6) var<storage,read_write> moments:array<vec4<f32>>;
@group(0) @binding(7) var<storage,read> geometry:array<vec4<f32>>;
@group(0) @binding(8) var<storage,read> curves:array<vec4<f32>>;

fn wrapDelta(d:vec2<f32>)->vec2<f32>{return d-floor(d+vec2<f32>(.5));}
fn pairForce(delta:vec2<f32>,receiverType:u32,sourceType:u32)->vec2<f32>{
  let d2=dot(delta,delta);if(d2==0. || d2>=params.radius*params.radius){return vec2<f32>(0.);}
  let d=sqrt(d2);let r=d/params.radius;var value=0.;
  if(r<.08){value=-(1.-r/.08)*(1.-r/.08);}
  else{
    let curve=curves[receiverType*4u+sourceType];var t=0.;var a=0.;
    if(r<curve.z){t=(r-.08)/(curve.z-.08);a=curve.x;}
    else{t=(r-curve.z)/(1.-curve.z);a=curve.y;}
    value=a*16.*t*t*(1.-t)*(1.-t);
  }
  return delta*(value*params.strength/d);
}
@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) id:vec3<u32>){if(id.x<params.leafCount){atomicStore(&heads[id.x],-1);}}
@compute @workgroup_size(64)
fn insert(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=params.count){return;}let dim=1u<<params.depth;
  let xy=min(vec2<u32>(inputParticles[i].xy*f32(dim)),vec2<u32>(dim-1u));var code=0u;
  for(var b=0u;b<params.depth;b++){code=code|(((xy.x>>b)&1u)<<(2u*b))|(((xy.y>>b)&1u)<<(2u*b+1u));}
  links[i]=atomicExchange(&heads[code],i32(i));
}
@compute @workgroup_size(64)
fn leaves(@builtin(global_invocation_id) id:vec3<u32>){
  let leaf=id.x;if(leaf>=params.leafCount){return;}
  var sums:array<vec4<f32>,4>;
  var j=atomicLoad(&heads[leaf]);
  loop{if(j<0){break;}let i=u32(j);let t=species[i];sums[t]+=vec4<f32>(inputParticles[i].xy,1.,0.);j=links[i];}
  for(var t=0u;t<4u;t++){moments[(params.firstLeaf+leaf)*4u+t]=sums[t];}
}
@compute @workgroup_size(64)
fn reduce(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x>=params.levelCount){return;}let node=params.levelStart+id.x;
  for(var t=0u;t<4u;t++){
    var sum=vec4<f32>(0.);for(var q=0u;q<4u;q++){sum+=moments[(node*4u+1u+q)*4u+t];}
    moments[node*4u+t]=sum;
  }
}
@compute @workgroup_size(64)
fn advance(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=params.count){return;}let p=inputParticles[i];let receiverType=species[i];var acceleration=vec2<f32>(0.);var node=0u;
  loop{
    if(node>=params.nodeCount){break;}
    let g=geometry[node];let escape=u32(g.w);let base=node*4u;
    let count=moments[base].z+moments[base+1u].z+moments[base+2u].z+moments[base+3u].z;
    if(count==0.){node=escape;continue;}
    let delta=abs(wrapDelta(g.xy-p.xy));let halfSize=g.z*.5;
    let near=max(vec2<f32>(0.),delta-vec2<f32>(halfSize));let min2=dot(near,near);let radius2=params.radius*params.radius;
    if(min2>=radius2){node=escape;continue;}
    let far=delta+vec2<f32>(halfSize);let max2=dot(far,far);
    var accept=params.theta>0. && g.z*g.z<params.theta*params.theta*dot(delta,delta) && min2>.0064*radius2 && max2<radius2 && all(far<vec2<f32>(.5));
    if(accept){
      for(var t=0u;t<4u;t++){
        if(moments[base+t].z==0.){continue;}
        let split=curves[receiverType*4u+t].z*params.radius;
        let curve=curves[receiverType*4u+t];
        let bandWidth=select(1.-curve.z,curve.z-.08,max2<split*split)*params.radius;
        if((min2<=split*split && max2>=split*split) || sqrt(max2)-sqrt(min2)>params.theta*.5*bandWidth){accept=false;break;}
      }
    }
    if(accept){
      for(var t=0u;t<4u;t++){
        let m=moments[base+t];if(m.z>0.){acceleration+=pairForce(wrapDelta(m.xy/m.z-p.xy),receiverType,t)*m.z;}
      }
      node=escape;
    }else if(node<params.firstLeaf){node=node*4u+1u;}
    else{
      var j=atomicLoad(&heads[node-params.firstLeaf]);
      loop{if(j<0){break;}let k=u32(j);if(k!=i){acceleration+=pairForce(wrapDelta(inputParticles[k].xy-p.xy),receiverType,species[k]);}j=links[k];}
      node=escape;
    }
  }
  let velocity=integrateVelocity(p.zw,acceleration,params.damping,bitcast<f32>(params.pad));
  let position=p.xy+velocity/60.;outputParticles[i]=vec4<f32>(min(position-floor(position),vec2<f32>(.99999988)),velocity);
}
// Reuse the moment buffer as display scratch after all tree work is complete.
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x*2u;if(i>=params.count){return;}
  var b=vec2<f32>(0.);if(i+1u<params.count){b=inputParticles[i+1u].xy;}
  moments[id.x]=vec4<f32>(inputParticles[i].xy,b);
}

