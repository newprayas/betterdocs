'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

interface UseAuthGuardOptions {
  requireAuth?: boolean;
}

export function useAuthGuard(options: UseAuthGuardOptions = {}) {
  const { requireAuth = true } = options;
  const router = useRouter();
  const pathname = usePathname();
  const supabase = useMemo(() => createClient(), []);

  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    let isActive = true;

    const redirectToLogin = () => {
      const next = pathname || '/';
      router.replace(`/login?redirectedFrom=${encodeURIComponent(next)}`);
    };

    const redirectToHome = () => {
      router.replace('/');
    };

    const syncAuthState = (userId: string | null) => {
      const authed = Boolean(userId);
      setIsAuthenticated(authed);
      setIsCheckingAuth(false);

      if (requireAuth && !authed) {
        redirectToLogin();
      }

      if (!requireAuth && authed) {
        redirectToHome();
      }
    };

    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      let userId = session?.user?.id || null;
      if (!userId) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        userId = user?.id || null;
      }

      if (!isActive) return;
      syncAuthState(userId);
    };

    checkAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isActive) return;
      syncAuthState(session?.user?.id || null);
    });

    return () => {
      isActive = false;
      subscription.unsubscribe();
    };
  }, [pathname, requireAuth, router, supabase]);

  return { isCheckingAuth, isAuthenticated };
}
