import { SignIn } from '@clerk/nextjs';
import { Logo } from '../../../lib/cp-shared';

export const metadata = {
  title: 'Sign In · CatalystPit',
};

export default function SignInPage() {
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
      {/* Branded header */}
      <div style={{
        textAlign: 'center',
        marginBottom: 32,
      }}>
        <a href="/" style={{ textDecoration: 'none', display: 'inline-block' }}>
          <Logo size={44/30}/>
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

      {/* Clerk's sign-in form */}
      <SignIn />

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

      {/* ⚠️ THE TERMS SAY AGREEMENT IS FORMED BY USING THE SERVICE, AND THIS IS WHERE AN
          ACCOUNT IS CREATED. Clerk owns the form, so the line sits under it rather than as a
          checkbox — the existing auth architecture does not require one, and adding a blocking
          gate to a hosted component is a conversion change, not a disclosure one. */}
      <div style={{
        marginTop: 18,
        maxWidth: 380,
        textAlign: 'center',
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 11.5,
        lineHeight: 1.5,
        color: '#5A6458',
        fontWeight: 300,
      }}>
        By signing in, you agree to the <a href="/terms" style={{ color: '#1E5C38' }}>Terms of Service</a>
        {' '}and acknowledge the <a href="/privacy" style={{ color: '#1E5C38' }}>Privacy Policy</a>
        {' '}and <a href="/disclaimer" style={{ color: '#1E5C38' }}>Financial Disclaimer</a>.
      </div>
      {/* Bottom tagline */}
      <div style={{
        marginTop: 40,
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 10,
        color: '#8A9088',
        letterSpacing: '1.5px',
      }}>
        FINANCIAL INTELLIGENCE · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
