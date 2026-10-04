// Shared bounded-impulse integration for all GPU backends. No force means no extra drag.
fn integrateVelocity(old:vec2<f32>,acceleration:vec2<f32>,damping:f32,maximum:f32)->vec2<f32>{
  if(maximum<=0.){return (old+acceleration/60.)*damping;}
  let limit=maximum*(1.-1e-6);let limit2=limit*limit;
  var v=old*damping;let speed2=dot(v,v);
  if(speed2>=limit2){v*=limit*(1.-1e-6)/sqrt(speed2);}
  if(all(acceleration==vec2<f32>(0.))){return v;}
  let momentum=v/sqrt(max(1e-12,1.-dot(v,v)/limit2))+acceleration/60.*damping;
  return momentum/sqrt(1.+dot(momentum,momentum)/limit2);
}
