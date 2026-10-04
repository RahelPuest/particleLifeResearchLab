// Two independent complex channels per texel: (real X, imaginary X, real Y, imaginary Y).
// A complete radix-2 line transform stays in workgroup memory; two dispatches form a 2D FFT.
struct FFTParams { dim:u32, logDim:u32, axis:u32, inverse:u32 }
@group(0) @binding(0) var<uniform> p:FFTParams;
@group(0) @binding(1) var<storage,read> input:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4<f32>>;
var<workgroup> line:array<vec4<f32>,256>;
fn address(i:u32,row:u32,layer:u32)->u32 {
  return layer*p.dim*p.dim+select(row*p.dim+i,i*p.dim+row,p.axis==1u);
}
fn product(a:vec4<f32>,w:vec2<f32>)->vec4<f32> {
  return vec4<f32>(a.x*w.x-a.y*w.y,a.x*w.y+a.y*w.x,a.z*w.x-a.w*w.y,a.z*w.y+a.w*w.x);
}
@compute @workgroup_size(128)
fn fft(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
  for(var i=lane;i<p.dim;i+=128u) {
    let reversed=reverseBits(i)>>(32u-p.logDim);
    line[i]=input[address(reversed,group.x,group.y)];
  }
  workgroupBarrier();
  for(var size=2u;size<=p.dim;size*=2u) {
    if(lane<p.dim/2u) {
      let halfSize=size/2u;let j=lane%halfSize;
      let a=(lane/halfSize)*size+j;let b=a+halfSize;
      let angle=select(-1.,1.,p.inverse==1u)*6.28318530718*f32(j)/f32(size);
      let left=line[a];let right=product(line[b],vec2<f32>(cos(angle),sin(angle)));
      line[a]=left+right;line[b]=left-right;
    }
    workgroupBarrier();
  }
  for(var i=lane;i<p.dim;i+=128u) {
    output[address(i,group.x,group.y)]=line[i]/select(1.,f32(p.dim),p.inverse==1u);
  }
}
