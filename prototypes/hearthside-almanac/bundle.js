/* @ds-bundle: {"format":4,"namespace":"Hearthside","components":[{"name":"AppShell"},{"name":"Floor"},{"name":"GildedPanel"},{"name":"Nav"},{"name":"SectionHeading"},{"name":"QuestList"},{"name":"Letters"},{"name":"NoticeSheet"},{"name":"PlannerSteps"},{"name":"AvailabilityGrid"},{"name":"VoteTally"},{"name":"Ledger"},{"name":"Button"},{"name":"Seal"},{"name":"Tag"},{"name":"Avatar"}]} */
/* Hearthside: plain scripts, no framework. Most components are markup plus bundle.css; the five that need
   behaviour (Floor, GildedPanel, NoticeSheet, QuestList, AvailabilityGrid) have functions here. */
(function(){
  'use strict';
  var reduceMotion=function(){return !!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);};

  /* ---------------------------------------------------------------- Floor
     Honey-oak floorboards drawn by a fragment shader, lit by a hearth low on the left. The boards are
     generated, not tiled, so the floor runs on forever sideways: pan it as you change pages and it never
     repeats or shows a seam. The light stays put; only the boards move. */
  var WOOD_FS="#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nuniform vec2 uRes;\nuniform float uDpr;\nuniform float uW, uL;         // board width and base length, css px\nuniform float uRing, uKnots, uChecks, uRelief, uGloss;\nuniform vec3 uEarly, uLate, uDeep, uFireCol;\nuniform vec2 uFire;           // the hearth, as a fraction of the screen\nuniform float uPan;           // how far the floor has slid sideways, css px\n\nfloat gIron;\n\nfloat h12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);\n  return mix(mix(h12(i),h12(i+vec2(1.,0.)),u.x),mix(h12(i+vec2(0.,1.)),h12(i+vec2(1.,1.)),u.x),u.y);}\nfloat fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vn(p);p=p*2.03+vec2(17.13,9.71);a*=.5;}return s;}\n\nvec4 wood(vec2 p){\n  gIron=0.;\n  float row=floor(p.y/uW),ly=p.y-row*uW;\n  float L=uL*(.7+.6*h12(vec2(row,3.7)));\n  float s=p.x+h12(vec2(row,9.1))*L;             // stagger the butt joints row to row\n  float cI=floor(s/L),lx=s-cI*L;\n  vec2 id=vec2(row,cI);\n  float hA=h12(id+.13),hB=h12(id+7.31),hC=h12(id+3.77),hD=h12(id+11.9);\n\n  // knots come first, because everything else flows around them. The grain parts round a knot the way\n  // water parts round a stone (potential flow past a cylinder), so instead of decorating the board we bend\n  // its coordinates: g is where each point \"came from\" upstream, and rings, fibres, pores and streaks all\n  // read g, so they all swerve together and close up again behind the knot.\n  vec2 g=vec2(lx,ly);\n  float knot=0.,kRad=0.,kAng=0.,kId=0.,kHalo=0.;\n  for(int k=0;k<2;k++){\n    float fk=float(k);\n    if(h12(id+19.7+fk*5.3)<uKnots){\n      vec2 kc=vec2(L*(.08+.84*h12(id+23.1+fk*3.1)),uW*(.24+.52*h12(id+29.3+fk*2.7)));\n      float R=3.+5.5*h12(id+31.7+fk);              // half-width across the grain\n      vec2 d=vec2(lx,ly)-kc;\n      vec2 q=vec2(d.x*.45,d.y);                    // a branch cut on the slant: an oval about twice as long as it is wide\n      float rho=max(length(q),1e-3),a=atan(q.y,q.x);\n      float Rn=R*(1.+.22*(vn(vec2(a*1.7+fk*7.,hA*40.+fk))-.5));   // ragged outline\n      float k2=min(R*R/(rho*rho),1.);\n      // phi = x(1+R\u00b2/\u03c1\u00b2) along the grain, psi = y(1\u2212R\u00b2/\u03c1\u00b2) across it\n      g+=vec2(d.x*k2,-d.y*k2)*smoothstep(Rn*.9,Rn*1.05,rho);\n      kHalo=max(kHalo,exp(-max(rho-Rn,0.)/(R*.8))*step(Rn,rho));\n      float inside=1.-smoothstep(Rn-.6,Rn+.6,rho);\n      if(inside>knot){knot=inside;kRad=rho/Rn;kAng=a;kId=hA*17.+fk*5.;}\n    }\n  }\n\n  // growth rings: a log sawn at a slight tilt shows nested arches (cathedral grain)\n  float c=uW*(.15+.7*hA);\n  float ax=L*(.1+.8*hB);\n  float sl=hC<.3?.006+.02*hC:.03+.06*hC;\n  float across=g.y-c+(fbm(vec2(g.x*.004,g.y*.02)+hD*40.)-.5)*uW*.35;\n  float along=(g.x-ax)*sl;\n  float r=sqrt(across*across+along*along);\n  r+=(fbm(vec2(g.x*.015,g.y*.08)+hA*90.)-.5)*uRing*1.4;\n\n  float t=fract(r/uRing);\n  float late=smoothstep(.35,.9,t)*(1.-smoothstep(.9,1.,t));\n  float fib=vn(vec2(g.x*.045,g.y*1.1)+hB*60.);\n  float fib2=vn(vec2(g.x*.12,g.y*2.4)+hC*30.);\n  float pore=smoothstep(.74,.95,vn(vec2(g.x*.25,g.y*1.6)+hD*11.));\n\n  vec3 base=uEarly*(.82+.36*hA);\n  base=mix(base,uDeep*1.6,.35*hD*hD);           // the odd darker, redder board\n  vec3 col=mix(base,uLate,late*.85);\n  col*=.86+.2*fib+.08*fib2;\n  col=mix(col,uDeep,pore*.3);\n  col*=.8+.4*fbm(vec2(g.x*.0025,g.y*.015)+hB*5.); // mineral streaks\n  // grain crowded against a knot runs darker and a touch redder, where resin collects\n  col=mix(col,uDeep*1.5,kHalo*.4);\n\n  // the knot itself is end grain: its own tight rings, darkening toward a ragged bark edge, with a check or two\n  float kRings=smoothstep(.25,.85,fract(kRad*3.4+.15*vn(vec2(kAng*2.,kId))));\n  vec3 kCol=mix(uDeep*1.35,uDeep*.8,kRings);\n  kCol=mix(kCol,uDeep*.45,smoothstep(.55,1.,kRad)*(.55+.45*vn(vec2(kAng*3.,kId+3.))));\n  kCol=mix(kCol,uDeep*.3,smoothstep(.86,.97,vn(vec2(kAng*4.5,kId+9.)))*smoothstep(.15,.5,kRad));\n  col=mix(col,kCol,knot);\n  float hgt=late*uRelief+fib*.12+knot*.3;\n\n  // joints\n  float e=min(min(ly,uW-ly),min(lx,L-lx));\n  hgt+=(smoothstep(0.,3.,e)-1.)*2.2;\n  col*=.72+.28*smoothstep(0.,6.,e);              // grime packed into the joints\n  col=mix(col,vec3(.018,.011,.007),1.-smoothstep(.35,1.25,e));\n\n  // checks: splits that open along the grain, mostly from the board ends\n  float ck=0.;\n  for(int i=0;i<2;i++){\n    float fi=float(i);\n    if(h12(id+51.+fi*7.)<uChecks){\n      float cy=uW*(.2+.6*h12(id+53.+fi*3.));\n      float len=50.+170.*h12(id+57.+fi);\n      bool atEnd=h12(id+59.+fi)<.6;\n      bool fromStart=h12(id+63.+fi)<.5;\n      float x0=atEnd?(fromStart?0.:L-len):L*.8*h12(id+61.+fi);\n      float tt=(lx-x0)/len;\n      if(tt>0.&&tt<1.){\n        float taper=atEnd?(fromStart?1.-tt:tt):sin(3.1416*tt);\n        float wv=(vn(vec2(lx*.03,fi*9.+row))-.5)*5.;\n        float wd=.25+1.4*taper;\n        ck=max(ck,1.-smoothstep(wd*.5,wd+.35,abs(ly-cy-wv)));\n      }\n    }\n  }\n  col=mix(col,vec3(.02,.012,.008),ck*.9);\n  hgt-=ck*1.5;\n\n  // cut nails: a pair at each board end and over every joist\n  float jx=(floor(p.x/400.)+.5)*400.;\n  float dx=min(min(abs(lx-11.),abs(lx-L+11.)),abs(p.x-jx));\n  float dy=min(abs(ly-uW*.27),abs(ly-uW*.73));\n  float dn=max(dx*.8,dy*1.2);\n  float head=1.-smoothstep(2.1,2.9,dn);\n  col*=1.-.4*exp(-dn*dn/30.);                    // iron bleeds into the oak\n  col=mix(col,vec3(.11,.10,.095),head);\n  hgt+=head*1.3*sqrt(max(0.,1.-dn*dn/7.8));\n  gIron=head;\n\n  return vec4(col,hgt);\n}\n\nvoid main(){\n  vec2 S=uRes/uDpr;\n  vec2 p=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uDpr;   // the screen: the firelight lives here\n  vec2 f=p+vec2(uPan,0.);                                     // the floor: endless sideways, so any pan is seamless\n  vec4 w=wood(f);\n  float iron=gIron;\n  float e=.75;\n  float hx=wood(f+vec2(e,0.)).a,hy=wood(f+vec2(0.,e)).a;\n  vec3 n=normalize(vec3(-(hx-w.a)/e,-(hy-w.a)/e,1.3));\n  vec3 col=w.rgb;\n\n  // a worn path meandering across the floor\n  float pathY=S.y*(.72+.2*sin(f.x*.0011+.6))+50.*sin(f.x*.0047);\n  float dp=(f.y-pathY)/190.;\n  float wear=exp(-dp*dp)*(.5+.5*fbm(f*.008));\n  col=mix(col,vec3(dot(col,vec3(.3,.55,.15)))*vec3(1.25,1.1,.95),wear*.3);\n  float gloss=uGloss*(1.-wear*.75);\n\n  // scuffs\n  float sc=0.;\n  for(int i=0;i<3;i++){\n    float a=float(i)*2.1+.5;vec2 rp=mat2(cos(a),-sin(a),sin(a),cos(a))*f;\n    sc+=smoothstep(.94,.995,vn(vec2(rp.x*.004,rp.y*.8)+float(i)*13.))*vn(rp*.01+float(i)*5.);\n  }\n  col+=vec3(.07,.05,.03)*sc;\n\n  // firelight from the hearth, low and to the left, raking across the boards\n  vec3 F=vec3(uFire*S,240.);\n  vec3 Lv=F-vec3(p,0.);\n  float dist=length(Lv.xy);\n  vec3 l=normalize(Lv);\n  float fall=1./(1.+pow(dist/(max(S.x,S.y)*.55),2.));\n  float diff=max(dot(n,l),0.);\n  vec3 hv=normalize(l+vec3(0.,0.,1.));\n  float nh=max(dot(n,hv),0.);\n  float spec=(pow(nh,8.)*.25+pow(nh,60.))*gloss+pow(nh,90.)*iron*1.5;\n  vec3 amb=vec3(.17,.15,.14)+vec3(.04,.05,.07)*(1.-p.y/S.y);\n  vec3 lit=col*(amb+uFireCol*diff*2.*fall)+uFireCol*spec*fall;\n  float v=length((p/S-.5)*vec2(1.,1.15));\n  lit*=1.-smoothstep(.35,.95,v)*.5;\n  lit+=(h12(gl_FragCoord.xy)-.5)/255.;\n  gl_FragColor=vec4(lit,1.);\n}\n";
  var FLOOR={W:86,L:560,ring:5,knots:.3,checks:.18,relief:-.15,gloss:.55,
    early:[.52,.36,.21],late:[.32,.20,.11],deep:[.19,.11,.06],fire:[1,.7,.42],hearth:[-.04,1.04]};

  function mountFloor(canvas,opts){
    opts=opts||{};
    var inline=!!opts.inline, step=opts.step==null?200:opts.step;
    var f={};for(var k in FLOOR)f[k]=FLOOR[k];if(opts.wood)for(var j in opts.wood)f[j]=opts.wood[j];
    var gl=null,prog=null;
    try{
      gl=canvas.getContext('webgl',{antialias:false,preserveDrawingBuffer:true});
      if(gl){
        var sh=function(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
        prog=gl.createProgram();
        gl.attachShader(prog,sh(gl.VERTEX_SHADER,'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'));
        gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,WOOD_FS));
        gl.linkProgram(prog);
        if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
        var a=gl.getAttribLocation(prog,'a');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
      }
    }catch(err){console.error('Hearthside.Floor:',err);gl=null;}
    if(!gl){
      canvas.style.display='none';
      (opts.fallback||document.body).classList.add('hs-ground');
      var noop=function(){};
      return {ok:false,panTo:noop,page:noop,redraw:noop};
    }
    var U=function(n){return gl.getUniformLocation(prog,n);};
    var drawnW=0,drawnH=0,pan=0,vel=0,target=0,raf=0;
    function size(){
      if(inline){var r=canvas.getBoundingClientRect();return [Math.max(1,r.width),Math.max(1,r.height)];}
      // never shrink the height, so a phone's collapsing URL bar doesn't force a redraw
      var w=window.innerWidth;return [w,Math.max(window.innerHeight,drawnW===w?drawnH:0)];
    }
    function draw(moving){
      var s=size(),w=s[0],h=s[1];drawnW=w;drawnH=h;
      // mid-pan frames draw at 1x so the slide stays smooth; the resting frame redraws sharp
      var dpr=Math.min(window.devicePixelRatio||1,moving?1:2);
      var bw=Math.round(w*dpr),bh=Math.round(h*dpr);
      if(canvas.width!==bw||canvas.height!==bh){if(!inline)canvas.style.height=h+'px';canvas.width=bw;canvas.height=bh;}
      gl.viewport(0,0,bw,bh);
      gl.uniform2f(U('uRes'),bw,bh);gl.uniform1f(U('uDpr'),bw/w);gl.uniform1f(U('uPan'),pan);
      gl.uniform1f(U('uW'),f.W);gl.uniform1f(U('uL'),f.L);
      gl.uniform1f(U('uRing'),f.ring);gl.uniform1f(U('uKnots'),f.knots);gl.uniform1f(U('uChecks'),f.checks);
      gl.uniform1f(U('uRelief'),f.relief);gl.uniform1f(U('uGloss'),f.gloss);
      gl.uniform3fv(U('uEarly'),f.early);gl.uniform3fv(U('uLate'),f.late);gl.uniform3fv(U('uDeep'),f.deep);
      gl.uniform3fv(U('uFireCol'),f.fire);gl.uniform2fv(U('uFire'),f.hearth);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    // a spring, stiffness 200 and damping 25: the same feel as the main app's brick wall
    function panTo(x,animate){
      target=x;cancelAnimationFrame(raf);
      if(animate===false||reduceMotion()){pan=x;vel=0;draw();return;}
      var last=performance.now();
      var tick=function(now){
        var dt=Math.min(.032,(now-last)/1000);last=now;
        vel+=(-200*(pan-target)-25*vel)*dt;pan+=vel*dt;
        var done=Math.abs(pan-target)<.3&&Math.abs(vel)<2;
        if(done){pan=target;vel=0;}
        draw(!done);
        if(!done)raf=requestAnimationFrame(tick);
      };
      raf=requestAnimationFrame(tick);
    }
    var rr=0,redraw=function(){cancelAnimationFrame(rr);rr=requestAnimationFrame(function(){draw();});};
    if(inline&&window.ResizeObserver)new ResizeObserver(redraw).observe(canvas);
    else window.addEventListener('resize',function(){if(window.innerWidth===drawnW&&window.innerHeight<=drawnH)return;redraw();});
    draw();
    return {ok:true,panTo:panTo,page:function(i,animate){panTo(i*step,animate);},redraw:redraw};
  }

  /* ---------------------------------------------------------------- GildedPanel
     Adds the hairline and the four filigree corners to every .hs-gilded under root. Safe to call again. */
  var FILIGREE='<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'+
    '<linearGradient id="hs-gold" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="36" y2="36">'+
    '<stop offset="0" stop-color="#fbe8ab"/><stop offset=".3" stop-color="#d6a84e"/><stop offset=".55" stop-color="#8a5c1c"/><stop offset=".8" stop-color="#ecc771"/><stop offset="1" stop-color="#a87228"/></linearGradient>'+
    '<symbol id="hs-flourish" viewBox="0 0 40 40">'+
    '<path d="M2 2H21L17.5 5.5H5.5V17.5L2 21Z" fill="url(#hs-gold)"/>'+
    '<path d="M8 8C12 9 16 12 18 18C12 16 9 12 8 8Z" fill="url(#hs-gold)"/>'+
    '<g fill="none" stroke="url(#hs-gold)" stroke-width="1.3" stroke-linecap="round">'+
    '<path d="M17.5 7.5C22 7.5 26 10 30 8.6C33.6 7.3 34.3 4 31.8 3.3C29.8 2.8 28.9 5 30.5 5.9"/>'+
    '<path d="M7.5 17.5C7.5 22 10 26 8.6 30C7.3 33.6 4 34.3 3.3 31.8C2.8 29.8 5 28.9 5.9 30.5"/>'+
    '<path d="M11.5 7.2C13.4 4.8 16 4.6 17.4 6.2" stroke-width=".9"/><path d="M7.2 11.5C4.8 13.4 4.6 16 6.2 17.4" stroke-width=".9"/></g>'+
    '<circle cx="22.5" cy="12" r="1.2" fill="url(#hs-gold)"/><circle cx="12" cy="22.5" r="1.2" fill="url(#hs-gold)"/>'+
    '<circle cx="36.5" cy="9.5" r=".9" fill="url(#hs-gold)"/><circle cx="9.5" cy="36.5" r=".9" fill="url(#hs-gold)"/>'+
    '</symbol></defs></svg>';
  function gild(root){
    root=root||document;
    if(!document.getElementById('hs-flourish')){var d=document.createElement('div');d.innerHTML=FILIGREE;document.body.appendChild(d.firstChild);}
    var els=root.querySelectorAll?root.querySelectorAll('.hs-gilded'):[];
    for(var i=0;i<els.length;i++){
      var el=els[i];if(el.querySelector(':scope > .hs-gild'))continue;
      var g=document.createElement('span');g.className='hs-gild';g.setAttribute('aria-hidden','true');
      g.innerHTML=['tl','tr','bl','br'].map(function(k){return '<svg class="'+k+'" viewBox="0 0 40 40"><use href="#hs-flourish"/></svg>';}).join('');
      el.appendChild(g);
    }
  }

  /* ---------------------------------------------------------------- NoticeSheet
     A weathered parchment sheet drawn to fit its card. Each sheet is seeded from an id (use the session's
     id): the same session always ages the same way, and no two sessions match. Features sit at fractions
     of the sheet, so a resize stretches it rather than reshuffling it. */
  var PAD=34,DOG=20,CURL=40;   // room for the shadow; a dog-eared corner; a curled corner
  var hash=function(x,y){var s=Math.sin(x*127.1+y*311.7)*43758.5453;return s-Math.floor(s);};
  var vnoise=function(x,y){var i=Math.floor(x),j=Math.floor(y),fx=x-i,fy=y-j,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);
    var a=hash(i,j),b=hash(i+1,j),c=hash(i,j+1),d=hash(i+1,j+1);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;};
  var fbm=function(x,y){var s=0,a=.5;for(var o=0;o<4;o++){s+=a*vnoise(x,y);x=x*2.02+17.3;y=y*2.02+9.1;a*=.5;}return s;};
  var seeded=function(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;var t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};};
  var strSeed=function(s){var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
  // corner-local coordinates: a runs along the top or bottom edge, b along the side, both pointing into the sheet
  var CORNERS={tl:[0,0,1,0,0,1],tr:[1,0,-1,0,0,1],br:[1,1,-1,0,0,-1],bl:[0,1,1,0,0,-1]};
  var corner=function(k,w,h){var c=CORNERS[k];return function(a,b){return [c[0]*w+c[2]*a+c[4]*b,c[1]*h+c[3]*a+c[5]*b];};};

  // where this sheet is folded, torn, stained, dog-eared and curled
  function layout(seed){
    var r=seeded(seed),cut={tl:0,tr:0,br:0,bl:0};
    var dog=r()<.65?(r()<.5?'tl':'tr'):null,curl=r()<.85?(r()<.5?'br':'bl'):null;
    if(dog)cut[dog]=DOG;if(curl)cut[curl]=CURL;
    var ys=r()<.3?[.42+r()*.16]:[.3+r()*.1,.62+r()*.1];
    var foldsH=ys.map(function(y){return {y:y,tilt:(r()-.5)*8};});
    var foldV=r()<.7?{x:.44+r()*.12,tilt:(r()-.5)*8}:null;
    var tears=[];
    for(var i=0,n=r()<.35?2:1;i<n;i++)tears.push({edge:['left','right','bottom','top'][Math.floor(r()*4)],at:.15+r()*.7,w:4+r()*3,d:7+r()*6});
    var tide=r()<.7?{x:.1+r()*.8,y:.08+r()*.84,r:28+r()*20}:null;
    var hole=foldV&&r()<.5?Math.floor(r()*foldsH.length):-1;
    return {seed:seed,cut:cut,dog:dog,curl:curl,foldsH:foldsH,foldV:foldV,tears:tears,tide:tide,hole:hole,age:.8+r()*.4,ox:r()*200,oy:r()*200,skew:(r()-.5)*.24};
  }
  // the edge: a slight wobble, small nicks, tears, and splits where the folds meet it
  function outline(w,h,L){
    var rnd=seeded(L.seed^0x5bd1),cut=L.cut,pts=[],o=L.seed%1000;
    var nicks=function(){var n=[],k=1+Math.floor(rnd()*5);for(var i=0;i<k;i++)n.push({at:.06+rnd()*.88,w:3+rnd()*8,d:1.2+rnd()*3.2,round:rnd()<.5});return n;};
    var N={top:nicks(),right:nicks(),bottom:nicks(),left:nicks()};
    var along={top:function(x){return (x-cut.tl)/(w-cut.tl-cut.tr);},right:function(y){return (y-cut.tr)/(h-cut.tr-cut.br);},
      bottom:function(x){return (w-cut.br-x)/(w-cut.br-cut.bl);},left:function(y){return (h-cut.bl-y)/(h-cut.bl-cut.tl);}};
    L.foldsH.forEach(function(f){N.left.push({at:along.left(f.y*h-f.tilt/2),w:5,d:3.5});N.right.push({at:along.right(f.y*h+f.tilt/2),w:5,d:3});});
    if(L.foldV){N.top.push({at:along.top(L.foldV.x*w+L.foldV.tilt/2),w:5,d:3});N.bottom.push({at:along.bottom(L.foldV.x*w-L.foldV.tilt/2),w:5,d:3});}
    L.tears.forEach(function(t){N[t.edge].push({at:t.at,w:t.w,d:t.d});});
    var edge=function(x0,y0,x1,y1,nx,ny,list,off){
      var len=Math.hypot(x1-x0,y1-y0),n=Math.max(2,Math.ceil(len/2));off+=o;
      for(var i=0;i<n;i++){
        var t=i/n,s=t*len,d=.7+(vnoise((off+s)/34,off)*2-1)*1.1+(vnoise((off+s)/6,off+40)*2-1)*.35;
        for(var q=0;q<list.length;q++){var k=list[q],u=Math.abs(t-k.at)*len/(k.w/2);if(u<1)d+=k.d*(k.round?Math.sqrt(1-u*u):1-u);}
        pts.push([x0+(x1-x0)*t+nx*d,y0+(y1-y0)*t+ny*d]);
      }
    };
    edge(cut.tl,0,w-cut.tr,0,0,1,N.top,0);
    if(cut.tr)edge(w-cut.tr,0,w,cut.tr,-.707,.707,[],300);
    edge(w,cut.tr,w,h-cut.br,-1,0,N.right,500);
    if(cut.br)edge(w,h-cut.br,w-cut.br,h,-.707,-.707,[],900);
    edge(w-cut.br,h,cut.bl,h,0,-1,N.bottom,1300);
    if(cut.bl)edge(cut.bl,h,0,h-cut.bl,.707,-.707,[],1700);
    edge(0,h-cut.bl,0,cut.tl,1,0,N.left,1900);
    if(cut.tl)edge(0,cut.tl,cut.tl,0,.707,.707,[],2500);
    var p=new Path2D();pts.forEach(function(pt,i){if(i)p.lineTo(pt[0],pt[1]);else p.moveTo(pt[0],pt[1]);});p.closePath();
    return p;
  }
  // age: soft brown blotches, and browning that creeps in unevenly from the edges
  function ageLayer(w,h,L){
    var S=3,mw=Math.ceil(w/S),mh=Math.ceil(h/S),m=document.createElement('canvas');m.width=mw;m.height=mh;
    var mc=m.getContext('2d'),img=mc.createImageData(mw,mh),d=img.data;
    for(var j=0;j<mh;j++)for(var i=0;i<mw;i++){
      var x=i*S,y=j*S,n=fbm(x/110+L.ox,y/110+L.oy),n2=fbm(x/26+40+L.oy,y/26+40+L.ox);
      var age=1-Math.min(1,Math.max(0,(Math.min(x,y,w-x,h-y)+(n2-.5)*24)/30));
      var k=Math.min(1,Math.max(0,n-.42)*.9+age*age*.7*L.age+Math.max(0,n2-.62)*.5),o=(j*mw+i)*4;
      d[o]=255-k*70;d[o+1]=255-k*120;d[o+2]=255-k*185;d[o+3]=255;
    }
    mc.putImageData(img,0,0);return m;
  }
  function grainLayer(w,h,L){
    var gw=Math.ceil(w),gh=Math.ceil(h),g=document.createElement('canvas');g.width=gw;g.height=gh;
    var gc=g.getContext('2d'),img=gc.createImageData(gw,gh),d=img.data;
    for(var j=0;j<gh;j++)for(var i=0;i<gw;i++){var r=hash(i*.73+L.ox,j*.91+L.oy),v=255-r*r*r*46,o=(j*gw+i)*4;d[o]=v;d[o+1]=v-2;d[o+2]=v-6;d[o+3]=255;}
    gc.putImageData(img,0,0);return g;
  }
  function drawSheet(card,canvas,ctx,id){
    var w=card.offsetWidth,h=card.offsetHeight;if(!w||!h)return;
    var L=layout(strSeed(id)),dpr=Math.min(window.devicePixelRatio||1,2),c=ctx;
    canvas.style.cssText='left:'+(-PAD)+'px;top:'+(-PAD)+'px;width:'+(w+2*PAD)+'px;height:'+(h+2*PAD)+'px';
    canvas.width=Math.round((w+2*PAD)*dpr);canvas.height=Math.round((h+2*PAD)*dpr);
    c.setTransform(dpr,0,0,dpr,PAD*dpr,PAD*dpr);c.clearRect(-PAD,-PAD,w+2*PAD,h+2*PAD);
    var path=outline(w,h,L),aged=ageLayer(w,h,L),grained=grainLayer(w,h,L);
    // draw a shape far off the canvas so only its shadow lands here
    var shadow=function(shape,blur,dx,dy,color){c.save();c.shadowColor=color;c.shadowBlur=blur*dpr;c.shadowOffsetX=(dx+5000)*dpr;c.shadowOffsetY=dy*dpr;c.translate(-5000,0);c.fillStyle='#000';shape();c.restore();};
    var M,i,k,n;

    // shadows on the boards; a curled corner stands off the wood, so its shadow is deeper
    shadow(function(){c.fill(path);},22,3,12,'rgba(0,0,0,.55)');
    shadow(function(){c.fill(path);},3,0,2,'rgba(0,0,0,.4)');
    if(L.curl){M=corner(L.curl,w,h);shadow(function(){c.beginPath();c.moveTo.apply(c,M(CURL+2,0));c.lineTo.apply(c,M(0,CURL+2));c.lineTo.apply(c,M(-4,-4));c.closePath();c.fill();},12,0,9,'rgba(0,0,0,.5)');}

    c.save();c.clip(path);
    var base=c.createLinearGradient(0,0,w*.3,h);base.addColorStop(0,'#f0e3c4');base.addColorStop(1,'#e2cea5');
    c.fillStyle=base;c.fillRect(-2,-2,w+4,h+4);
    c.globalCompositeOperation='multiply';c.drawImage(aged,0,0,w,h);
    c.globalAlpha=.55;c.drawImage(grained,0,0,w,h);c.globalAlpha=1;c.globalCompositeOperation='source-over';

    // fibres in the pulp
    var rf=seeded(L.seed+7);c.lineCap='round';c.lineWidth=.6;
    for(i=0;i<Math.round(w*h/1800);i++){
      var x=rf()*w,y=rf()*h,a=rf()*Math.PI,l=3+rf()*9,b=(rf()-.5)*4,dark=rf()<.6;
      c.strokeStyle=dark?'rgba(110,75,40,.10)':'rgba(255,250,235,.25)';
      c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+Math.cos(a)*l/2-Math.sin(a)*b,y+Math.sin(a)*l/2+Math.cos(a)*b,x+Math.cos(a)*l,y+Math.sin(a)*l);c.stroke();
    }
    // foxing: rust-brown spots, mostly in clusters
    var rx=seeded(L.seed+23);
    var fox=function(x,y,r,a){var g=c.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(130,72,24,'+a+')');g.addColorStop(.6,'rgba(140,85,35,'+(a*.5)+')');g.addColorStop(1,'rgba(140,85,35,0)');c.fillStyle=g;c.beginPath();c.arc(x,y,r,0,7);c.fill();};
    for(k=0,n=2+Math.floor(rx()*4);k<n;k++){var cx=rx()*w,cy=rx()*h,m=5+Math.floor(rx()*10);for(i=0;i<m;i++)fox(cx+(rx()-.5)*60,cy+(rx()-.5)*50,.8+rx()*3.2,.15+rx()*.3);}
    for(i=0;i<26;i++)fox(rx()*w,rx()*h,.6+rx()*2,.1+rx()*.25);
    // a tide line where a tankard once sat on it
    if(L.tide){
      var tx=L.tide.x*w,ty=L.tide.y*h,tr=Math.min(L.tide.r,w*.09),q=L.seed%37;
      c.beginPath();
      for(i=0;i<=72;i++){var an=i/72*Math.PI*2,rr=tr*(1+(vnoise(Math.cos(an)*1.8+q,Math.sin(an)*1.8+q)-.5)*.45),X=tx+Math.cos(an)*rr,Y=ty+Math.sin(an)*rr*.85;if(i)c.lineTo(X,Y);else c.moveTo(X,Y);}
      c.closePath();c.fillStyle='rgba(160,110,50,.06)';c.fill();
      c.lineWidth=3;c.strokeStyle='rgba(130,85,35,.07)';c.stroke();c.lineWidth=1;c.strokeStyle='rgba(120,75,30,.2)';c.stroke();
    }
    // creases: the shaded face of the fold, grime in the fold, and the ridge catching the light
    var crease=function(x0,y0,x1,y1,k,seed){
      var len=Math.hypot(x1-x0,y1-y0),n=Math.ceil(len/6),nx=-(y1-y0)/len,ny=(x1-x0)/len,line=[];
      for(var i=0;i<=n;i++){var t=i/n,o=(vnoise(t*len/40,seed)-.5)*2.2;line.push([x0+(x1-x0)*t+nx*o,y0+(y1-y0)*t+ny*o]);}
      var stroke=function(off,wid,col){c.beginPath();line.forEach(function(p,i){if(i)c.lineTo(p[0]+nx*off,p[1]+ny*off);else c.moveTo(p[0]+nx*off,p[1]+ny*off);});c.lineWidth=wid;c.strokeStyle=col;c.stroke();};
      stroke(3,6,'rgba(95,60,25,'+(.07*k)+')');stroke(1.2,1.6,'rgba(90,55,22,'+(.16*k)+')');
      stroke(0,.9,'rgba(75,45,18,'+(.38*k)+')');stroke(-1.1,1.1,'rgba(255,250,232,'+(.55*k)+')');
    };
    var cs=L.seed%50;
    L.foldsH.forEach(function(f,i){crease(-6,f.y*h-f.tilt/2,w+6,f.y*h+f.tilt/2,1,3+i*4+cs);});
    if(L.foldV)crease(L.foldV.x*w+L.foldV.tilt/2,-6,L.foldV.x*w-L.foldV.tilt/2,h+6,.85,11+cs);
    var rw=seeded(L.seed+41);
    for(i=0;i<7;i++){var cn=i%4,wx=cn%2?w-rw()*w*.25:rw()*w*.25,wy=cn<2?rw()*h*.2:h-rw()*h*.2,wa=rw()*Math.PI,wl=16+rw()*40;crease(wx,wy,wx+Math.cos(wa)*wl,wy+Math.sin(wa)*wl,.45,20+i+cs);}
    for(i=0;i<5;i++){var pa=.45+i*.55+(rw()-.5)*.25,pl=12+rw()*20;crease(w/2+Math.cos(pa)*4,3+Math.sin(pa)*4,w/2+Math.cos(pa)*pl,3+Math.sin(pa)*pl,.45,60+i+cs);}   // puckers round the pin
    // the folds wear thin where they cross; on some sheets one has worn through
    if(L.foldV)L.foldsH.forEach(function(f,i){
      var x=L.foldV.x*w,y=f.y*h,g=c.createRadialGradient(x,y,0,x,y,8);
      g.addColorStop(0,'rgba(255,248,228,.45)');g.addColorStop(1,'rgba(255,248,228,0)');c.fillStyle=g;c.fillRect(x-8,y-8,16,16);
      if(i===L.hole){c.beginPath();for(var k=0;k<=10;k++){var a=k/10*Math.PI*2,r=1.6+hash(k,3+cs)*1.2;if(k)c.lineTo(x+Math.cos(a)*r,y+Math.sin(a)*r);else c.moveTo(x+Math.cos(a)*r,y+Math.sin(a)*r);}c.closePath();c.fillStyle='#2a1a0f';c.fill();c.strokeStyle='rgba(120,80,40,.5)';c.lineWidth=.8;c.stroke();}
    });
    // the edges lift: the side facing the fire catches it, the far side falls into shade
    var band=function(x0,y0,x1,y1,c0,c1){var g=c.createLinearGradient(x0,y0,x1,y1);g.addColorStop(0,c0);g.addColorStop(1,c1);c.fillStyle=g;
      if(x0!==x1)c.fillRect(Math.min(x0,x1)-1,-1,Math.abs(x1-x0)+2,h+2);else c.fillRect(-1,Math.min(y0,y1)-1,w+2,Math.abs(y1-y0)+2);};
    band(0,0,16,0,'rgba(255,244,215,.3)','rgba(255,244,215,0)');band(w,0,w-16,0,'rgba(70,40,15,.18)','rgba(70,40,15,0)');
    band(0,h,0,h-14,'rgba(255,240,205,.22)','rgba(255,240,205,0)');band(0,0,0,12,'rgba(70,40,15,.14)','rgba(70,40,15,0)');
    c.restore();

    // dog-eared corner: the folded flap shows the back of the sheet
    if(L.dog){
      M=corner(L.dog,w,h);var d=DOG,K0=M(0,0),Ks=M(1.5,2.5);
      var flapD=function(){c.beginPath();c.moveTo.apply(c,M(d,0));c.lineTo.apply(c,M(0,d));c.lineTo.apply(c,M(d-1,d+1));c.closePath();};
      shadow(function(){flapD();c.fill();},5,Ks[0]-K0[0],Ks[1]-K0[1],'rgba(40,25,10,.4)');
      var g0=M(d/2,d/2),g1=M(d,d),fg=c.createLinearGradient(g0[0],g0[1],g1[0],g1[1]);fg.addColorStop(0,'#d3bb8c');fg.addColorStop(1,'#e9d8b3');
      flapD();c.fillStyle=fg;c.fill();
      c.beginPath();c.moveTo.apply(c,M(d,0));c.lineTo.apply(c,M(0,d));c.strokeStyle='rgba(255,248,230,.65)';c.lineWidth=.8;c.stroke();
    }
    // curled corner: it rolls up and back over the sheet, but parchment keeps its point
    if(L.curl){
      M=corner(L.curl,w,h);var kc=CURL,P1=M(kc,0),P2=M(0,kc),T=M(kc*(.86-.707*L.skew),kc*(.86+.707*L.skew));
      var G=[(P1[0]+P2[0]+T[0])/3,(P1[1]+P2[1]+T[1])/3];
      // each side of the flap bows outward a little; they still meet at a sharp tip
      var bowed=function(A,B,amt){var mx=(A[0]+B[0])/2,my=(A[1]+B[1])/2,dx=mx-G[0],dy=my-G[1],l=Math.hypot(dx,dy)||1;return [mx+dx/l*amt,my+dy/l*amt];};
      var C1=bowed(P1,T,kc*.1),C2=bowed(P2,T,kc*.04);
      var flapC=function(){c.beginPath();c.moveTo(P1[0],P1[1]);c.quadraticCurveTo(C1[0],C1[1],T[0],T[1]);c.quadraticCurveTo(C2[0],C2[1],P2[0],P2[1]);c.closePath();};
      var F=[(P1[0]+P2[0])/2,(P1[1]+P2[1])/2],fl=Math.hypot(T[0]-F[0],T[1]-F[1]);
      shadow(function(){flapC();c.fill();},7,(T[0]-F[0])/fl*3,(T[1]-F[1])/fl*3+1,'rgba(45,28,10,.42)');
      var lg=c.createLinearGradient(F[0],F[1],T[0],T[1]);
      lg.addColorStop(0,'#8d6e44');lg.addColorStop(.3,'#b0966a');lg.addColorStop(.62,'#c9b287');lg.addColorStop(1,'#bba076');
      flapC();c.fillStyle=lg;c.fill();
      // the back of the sheet is as aged as the front, so the roll stays matte
      c.save();flapC();c.clip();c.globalCompositeOperation='multiply';c.drawImage(aged,0,0,w,h);c.globalAlpha=.6;c.drawImage(grained,0,0,w,h);c.restore();
      flapC();c.strokeStyle='rgba(80,52,22,.45)';c.lineWidth=.8;c.stroke();
      c.beginPath();c.moveTo(P1[0],P1[1]);c.lineTo(P2[0],P2[1]);c.strokeStyle='rgba(60,38,16,.3)';c.lineWidth=1;c.stroke();   // where it lifts off
    }
  }
  function mountSheet(card,opts){
    opts=opts||{};
    var id=opts.seed||card.getAttribute('data-seed')||'hearthside';
    var canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    if(!ctx)return {ok:false,setSeed:function(){},redraw:function(){}};
    canvas.className='hs-sheet-paper';canvas.setAttribute('aria-hidden','true');
    card.insertBefore(canvas,card.firstChild);card.classList.add('is-drawn');
    var raf=0,sw=0,sh=0,redraw=function(){cancelAnimationFrame(raf);raf=requestAnimationFrame(function(){drawSheet(card,canvas,ctx,id);});};
    if(window.ResizeObserver)new ResizeObserver(function(){if(card.offsetWidth===sw&&card.offsetHeight===sh)return;sw=card.offsetWidth;sh=card.offsetHeight;redraw();}).observe(card);
    else window.addEventListener('resize',redraw);
    redraw();
    return {ok:true,setSeed:function(s){id=String(s);redraw();},redraw:redraw};
  }

  /* ---------------------------------------------------------------- QuestList
     Checking a quest strikes it through and keeps an "N open" count up to date. */
  function bindQuests(list,opts){
    opts=opts||{};
    var count=function(){return list.querySelectorAll('.hs-box[aria-checked="false"]').length;};
    list.addEventListener('click',function(e){
      var box=e.target.closest&&e.target.closest('.hs-box');if(!box||!list.contains(box))return;
      var done=box.getAttribute('aria-checked')!=='true';
      box.setAttribute('aria-checked',String(done));
      var li=box.closest('li');if(li)li.classList.toggle('is-done',done);
      if(opts.count)opts.count.textContent=count()+' open';
      if(opts.onChange)opts.onChange(li,done);
    });
    if(opts.count)opts.count.textContent=count()+' open';
  }

  /* ---------------------------------------------------------------- AvailabilityGrid
     Who is free when: rows are evening slots, columns are days, each cell how many players are free. */
  function renderAvailability(el,o){
    var days=o.days||[['Mon','Mo'],['Tue','Tu'],['Wed','We'],['Thu','Th'],['Fri','Fr'],['Sat','Sa'],['Sun','Su']];
    var total=o.total||5,suffix=o.suffix==null?' pm':o.suffix,esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
    // heat level: 0 nobody, 1-4 by share of the party, 5 everyone (drawn like 4, and the only one that can be picked)
    var level=function(v){return v<=0?0:v>=total?5:Math.min(4,Math.ceil(v/total*4));};
    var h='<table><thead><tr><th class="corner"></th>'+days.map(function(d){return '<th scope="col"><span class="long">'+esc(d[0])+'</span><span class="short">'+esc(d[1]||d[0])+'</span></th>';}).join('')+'</tr></thead><tbody>';
    o.counts.forEach(function(row,i){
      h+='<tr><th class="row" scope="row">'+esc(o.slots[i])+'<span class="pm">'+esc(suffix)+'</span></th>'+row.map(function(v,j){
        var pick=o.pick&&o.pick[0]===i&&o.pick[1]===j;
        return '<td data-v="'+level(v)+'"'+(pick?' class="pick"':'')+' title="'+esc(days[j][0]+' '+o.slots[i]+suffix+': '+v+' of '+total+' free')+'">'+v+'</td>';
      }).join('')+'</tr>';
    });
    el.classList.add('hs-heat');el.innerHTML=h+'</tbody></table>';
    if(o.legend){o.legend.classList.add('hs-legend');o.legend.innerHTML='<span>fewer free</span><span class="swatches">'+[0,1,2,3,4].map(function(v){return '<i class="hs-sw" data-v="'+v+'"></i>';}).join('')+'</span><span>all '+total+' free</span>';}
  }

  window.Hearthside={
    AppShell:{className:'hs-shell'},
    Floor:{mount:mountFloor},
    GildedPanel:{className:'hs-gilded',decorate:gild},
    Nav:{className:'hs-nav'},
    SectionHeading:{className:'hs-sec'},
    QuestList:{className:'hs-quests',bind:bindQuests},
    Letters:{className:'hs-threads'},
    NoticeSheet:{className:'hs-sheet',mount:mountSheet},
    PlannerSteps:{className:'hs-steps'},
    AvailabilityGrid:{className:'hs-heat',render:renderAvailability},
    VoteTally:{className:'hs-votes'},
    Ledger:{className:'hs-ledger'},
    Button:{className:'hs-btn'},
    Seal:{className:'hs-seal'},
    Tag:{className:'hs-tag'},
    Avatar:{className:'hs-avatar'}
  };
})();
