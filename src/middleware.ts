import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
    console.log('🔍 [MIDDLEWARE] Processing request for:', request.nextUrl.pathname)
    
    let response = NextResponse.next({
        request: {
            headers: request.headers,
        },
    })

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                get(name: string) {
                    return request.cookies.get(name)?.value
                },
                set(name: string, value: string, options: CookieOptions) {
                    request.cookies.set({
                        name,
                        value,
                        ...options,
                    })
                    response = NextResponse.next({
                        request: {
                            headers: request.headers,
                        },
                    })
                    response.cookies.set({
                        name,
                        value,
                        ...options,
                    })
                },
                remove(name: string, options: CookieOptions) {
                    request.cookies.set({
                        name,
                        value: '',
                        ...options,
                    })
                    response = NextResponse.next({
                        request: {
                            headers: request.headers,
                        },
                    })
                    response.cookies.set({
                        name,
                        value: '',
                        ...options,
                    })
                },
            },
        }
    )

    const {
        data: { user },
    } = await supabase.auth.getUser()

    // If no user and not on login or signup page, redirect to login
    if (!user && !request.nextUrl.pathname.startsWith('/login') && !request.nextUrl.pathname.startsWith('/signup')) {
        console.log('🔍 [MIDDLEWARE] No user detected, redirecting to login from:', request.nextUrl.pathname)
        return NextResponse.redirect(new URL('/login', request.url))
    }

    // If user is logged in and on login page, redirect to home
    if (user && request.nextUrl.pathname.startsWith('/login')) {
        return NextResponse.redirect(new URL('/', request.url))
    }

    // Access Control Logic
    if (user) {
        // Check profile for subscription status
        const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single()

        if (profile) {
            const now = new Date()
            const trialStart = new Date(profile.trial_start_date)
            const trialEnd = new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 days
            const isSubscribed = profile.is_subscribed
            const isTrialActive = now < trialEnd

            // If trial expired and not subscribed, we might want to block access or show a modal.
            // For middleware, we can redirect to a "payment required" page or let the app handle the modal.
            // The user requested a modal, so we'll let the app handle it, but we pass a header or cookie to indicate status?
            // Or we can just let the client-side check handle the modal display.

            // However, to be secure, we should probably block API routes if expired.
            // For now, let's just ensure they are logged in. The modal will be handled in the layout.
        }
    }

    return response
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - auth/callback (auth callback)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js|css|json)$).*)',
    ],
}
