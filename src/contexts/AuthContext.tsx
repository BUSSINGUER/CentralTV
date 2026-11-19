import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  onIdTokenChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  authError: string | null;
  idToken: string | null;
  signInWithGoogle: () => Promise<User | null>;
  signOutGoogle: () => Promise<void>;
  getFreshToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (nextUser) {
        try {
          const token = await nextUser.getIdToken();
          setIdToken(token);
        } catch {
          setIdToken(null);
        }
      } else {
        setIdToken(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const token = await cred.user.getIdToken();
      setUser(cred.user);
      setIdToken(token);
      return cred.user;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Não foi possível concluir o login com o Google.';
      setAuthError(msg);
      return null;
    }
  }, []);

  const signOutGoogle = useCallback(async () => {
    setAuthError(null);
    await signOut(auth);
    setUser(null);
    setIdToken(null);
  }, []);

  const getFreshToken = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return null;
    try {
      const token = await current.getIdToken();
      setIdToken(token);
      return token;
    } catch {
      return idToken;
    }
  }, [idToken]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authError,
        idToken,
        signInWithGoogle,
        signOutGoogle,
        getFreshToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
