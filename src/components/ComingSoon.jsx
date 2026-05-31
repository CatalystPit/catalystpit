'use client'

import { Footer, TopNav, BrandStyles } from '../lib/cp-shared';
import { usePathname } from 'next/navigation';

const C = {
  bg:"#F5F6F3", white:"#FFFFFF", surface:"#F0F2EE", border:"#E0E2DC",
  ink:"#0C1410", text:"#1A2018", muted:"#5A6458", dim:"#8A9088",
  green:"#1E5C38", greenMid:"#2A7848", greenLight:"#E8F5EE", greenBorder:"#A8CEB8",
  navBg:"#1E5C38",
};

const Dot = () => (
  <span style={{display:"inline-block", width:6, height:6, borderRadius:"50%",
    background:C.green, animation:"cp-pulse 2s infinite", flexShrink:0}}/>
);

export default function ComingSoon({title, tagline, description, features=[]}) {
  // Highlight the matching nav link from the route — title is unreliable (e.g. /charts = "Live Charts").
  const seg = (usePathname() || '').split('/')[1] || '';
  const active = seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : undefined;
  return (
    <div style={{fontFamily:"'DM Sans',sans-serif", background:C.bg, color:C.text, minHeight:"100vh"}}>
      <BrandStyles/>
      <style>{`
        @keyframes cp-pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        .cta-btn:hover{background:${C.greenMid}!important;transform:translateY(-1px)}
        *{box-sizing:border-box}
      `}</style>

      {/* Shared polished nav (was a stale inline copy that missed the nav-polish updates) */}
      <TopNav active={active}/>

      {/* MAIN CONTENT */}
      <div style={{maxWidth:880, margin:"0 auto", padding:"80px 24px 100px",
        display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center"}}>

        {/* Status pill */}
        <div style={{display:"inline-flex", alignItems:"center", gap:8,
          background:C.greenLight, border:`1px solid ${C.greenBorder}`,
          padding:"6px 14px", borderRadius:20, marginBottom:24}}>
          <Dot/>
          <span style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, fontWeight:600,
            color:C.green, letterSpacing:"1.5px"}}>COMING SOON</span>
        </div>

        {/* Title */}
        <h1 style={{fontFamily:"'Cormorant Garamond',serif", fontSize:64, fontWeight:300,
          color:C.ink, margin:"0 0 16px", letterSpacing:"-1px", lineHeight:1.1}}>
          {title}
        </h1>

        {/* Tagline */}
        <p style={{fontSize:20, color:C.muted, fontWeight:300, lineHeight:1.5,
          maxWidth:640, margin:"0 0 32px"}}>{tagline}</p>

        {/* Description */}
        <p style={{fontSize:15, color:C.text, fontWeight:400, lineHeight:1.7,
          maxWidth:580, margin:"0 0 40px"}}>{description}</p>

        {/* Feature list (optional) */}
        {features.length > 0 && (
          <div style={{background:C.white, border:`1px solid ${C.border}`, borderRadius:8,
            padding:"24px 32px", marginBottom:48, width:"100%", maxWidth:520}}>
            <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:9, color:C.muted,
              letterSpacing:"1.5px", marginBottom:16, textAlign:"left"}}>WHAT'S COMING</div>
            <ul style={{listStyle:"none", padding:0, margin:0, display:"flex",
              flexDirection:"column", gap:10, textAlign:"left"}}>
              {features.map((f, i) => (
                <li key={i} style={{fontSize:14, color:C.text, display:"flex",
                  gap:10, alignItems:"flex-start", fontWeight:400}}>
                  <span style={{color:C.green, fontWeight:700, marginTop:1}}>→</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* CTA Section */}
        <div style={{background:"#0C1410", borderRadius:12, padding:"32px 40px",
          width:"100%", maxWidth:580, position:"relative", overflow:"hidden"}}>
          <div style={{position:"absolute", top:0, left:0, right:0, height:3,
            background:"linear-gradient(90deg, #5AB87A, #1E5C38)"}}/>
          <div style={{fontFamily:"'DM Sans',sans-serif", fontSize:10, color:"#5AB87A",
            letterSpacing:"1.5px", marginBottom:10}}>THE CATALYST BRIEF</div>
          <div style={{fontFamily:"'Cormorant Garamond',serif", fontSize:28, fontWeight:300,
            color:"#FFFFFF", lineHeight:1.3, marginBottom:8}}>
            Be the first to know.
          </div>
          <p style={{fontSize:14, color:"rgba(255,255,255,0.6)", fontWeight:300,
            lineHeight:1.6, margin:"0 0 20px"}}>
            Subscribe to The Catalyst Brief — daily 6 AM intelligence for active traders.
            Get notified the moment {title} launches.
          </p>
          <a href="https://newsletter.catalystpit.com" target="_blank" rel="noopener noreferrer"
            className="cta-btn"
            style={{display:"inline-block", background:C.green, color:"#FFFFFF",
              padding:"14px 32px", borderRadius:7, fontSize:14, fontWeight:600,
              fontFamily:"'DM Sans',sans-serif", textDecoration:"none",
              transition:"all 0.2s", border:"none", cursor:"pointer"}}>
            Subscribe to The Catalyst Brief →
          </a>
          <p style={{fontSize:11, color:"rgba(255,255,255,0.4)", marginTop:14,
            fontFamily:"'DM Sans',sans-serif", letterSpacing:"0.5px"}}>
            FREE FOREVER · NO CREDIT CARD
          </p>
        </div>

        {/* Back to home link */}
        <a href="/" style={{marginTop:32, fontSize:13, color:C.muted, textDecoration:"none",
          fontFamily:"'DM Sans',sans-serif", fontWeight:400}}>
          ← Back to homepage
        </a>
      </div>

      <Footer/>
    </div>
  );
}
