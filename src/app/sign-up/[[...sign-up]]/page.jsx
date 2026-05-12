import { SignUp } from '@clerk/nextjs';

export const metadata = {
  title: 'Sign Up — CatalystPit',
};

export default function SignUpPage() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#F5F6F3',
      padding: '40px 20px',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,600&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600;700&display=swap');
      `}</style>

      {/* Branded header */}
      <div style={{
        textAlign: 'center',
        marginBottom: 32,
      }}>
        <a href="/" style={{
          textDecoration: 'none',
          lineHeight: 1.05,
          display: 'inline-block',
        }}>
          <span style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 44,
            fontWeight: 300,
            color: '#0C1410',
            letterSpacing: '0.02em',
          }}>Catalyst</span>
          <span style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 44,
            fontWeight: 600,
            fontStyle: 'italic',
            color: '#1E5C38',
            letterSpacing: '0.01em',
          }}>Pit</span>
        </a>
        <div style={{
          marginTop: 8,
          fontSize: 13,
          color: '#5A6458',
          fontWeight: 300,
          letterSpacing: '0.02em',
        }}>
          Every catalyst. <span style={{ color: '#1E5C38', fontWeight: 500 }}>Before the bell.</span>
        </div>
      </div>

      {/* Clerk's sign-up form */}
      <SignUp />

      {/* Footer link */}
      <a href="/" style={{
        marginTop: 24,
        fontSize: 12,
        color: '#5A6458',
        textDecoration: 'none',
        fontFamily: "'DM Sans', sans-serif",
        fontWeight: 400,
      }}>
        ← Back to homepage
      </a>

      {/* Bottom tagline */}
      <div style={{
        marginTop: 40,
        fontFamily: "'DM Mono', monospace",
        fontSize: 10,
        color: '#8A9088',
        letterSpacing: '1.5px',
      }}>
        FINANCIAL INTELLIGENCE · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
