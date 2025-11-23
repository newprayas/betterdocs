'use client'

import { createClient } from '@/utils/supabase/client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SignUpPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [showPassword, setShowPassword] = useState(false)
    const router = useRouter()
    const supabase = createClient()

    // Debug logging for component mount
    useEffect(() => {
        console.log('🔍 [SIGNUP-PAGE] Component mounting...')
        console.log('🔍 [SIGNUP-PAGE] Current path:', window.location.pathname)
        console.log('🔍 [SIGNUP-PAGE] Router object available:', !!router)
        console.log('🔍 [SIGNUP-PAGE] Supabase client available:', !!supabase)
        console.log('🔍 [SIGNUP-PAGE] All state variables initialized')

        // Add a delay to ensure logging happens
        setTimeout(() => {
            console.log('🔍 [SIGNUP-PAGE] Component mounted successfully after delay')
        }, 100)
    }, [])

    // Add error boundary for component
    useEffect(() => {
        const handleError = (event: ErrorEvent) => {
            console.error('🔍 [SIGNUP-PAGE] JavaScript error:', event.error)
        }
        window.addEventListener('error', handleError)
        return () => window.removeEventListener('error', handleError)
    }, [])

    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const error = params.get('error')
        const error_description = params.get('error_description')
        const hashParams = new URLSearchParams(window.location.hash.substring(1))
        const hashError = hashParams.get('error')
        const hashErrorDescription = hashParams.get('error_description')

        if (error || hashError) {
            setError(error_description || hashErrorDescription || 'An error occurred during authentication')
        }
    }, [])

    const handleSignUp = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)
        setMessage(null)

        if (password.length < 6) {
            setError('Password must be at least 6 characters')
            setLoading(false)
            return
        }

        const { error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: `${location.origin}/auth/callback`,
            },
        })

        if (error) {
            setError(error.message)
        } else {
            setMessage('Check your email for the confirmation link.')
        }
        setLoading(false)
    }

    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-gray-900 px-6 py-12 lg:px-8">
            <div className="sm:mx-auto sm:w-full sm:max-w-sm flex flex-col items-center">
                <div className="h-16 w-16 bg-blue-500 rounded-lg flex items-center justify-center mb-4">
                    <svg
                        className="h-10 w-10 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                        />
                    </svg>
                </div>
                <h1 className="text-2xl font-bold text-white mb-2">MEDDY</h1>
                <p className="text-sm text-gray-400 mb-6">Made with ❤️ by Prayas</p>
                <h2 className="text-center text-xl font-semibold leading-9 tracking-tight text-white">
                    🎉 ;Make a new account 🎉
                </h2>
            </div>

            <div className="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
                <form className="space-y-6" onSubmit={handleSignUp}>
                    <div>
                        <label htmlFor="email" className="block text-sm font-medium leading-6 text-white">
                            Email address
                        </label>
                        <div className="mt-2">
                            <input
                                id="email"
                                name="email"
                                type="email"
                                autoComplete="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="block w-full rounded-md border-0 bg-white/5 py-1.5 text-white shadow-sm ring-1 ring-inset ring-white/10 focus:ring-2 focus:ring-inset focus:ring-indigo-500 sm:text-sm sm:leading-6"
                            />
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between">
                            <label htmlFor="password" className="block text-sm font-medium leading-6 text-white">
                                Password
                            </label>
                        </div>
                        <div className="mt-2 relative">
                            <input
                                id="password"
                                name="password"
                                type={showPassword ? "text" : "password"}
                                autoComplete="new-password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="block w-full rounded-md border-0 bg-white/5 py-1.5 text-white shadow-sm ring-1 ring-inset ring-white/10 focus:ring-2 focus:ring-inset focus:ring-indigo-500 sm:text-sm sm:leading-6 pr-10"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-300"
                            >
                                {showPassword ? (
                                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                    </svg>
                                ) : (
                                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div className="text-red-400 text-sm text-center">{error}</div>
                    )}

                    {message && (
                        <div className="text-green-400 text-sm text-center">{message}</div>
                    )}

                    <div>
                        <button
                            type="submit"
                            disabled={loading}
                            className="flex w-full justify-center rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-semibold leading-6 text-white shadow-sm hover:bg-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-50"
                        >
                            {loading ? 'Loading...' : 'Make my account'}
                        </button>
                    </div>
                </form>

                <p className="mt-10 text-center text-sm text-blue-400">
                    Already have an account?
                </p>
                <div className="mt-4 text-center">
                    <button
                        onClick={() => {
                            console.log('🔍 [SIGNUP-PAGE] "Sign in instead" button clicked')
                            console.log('🔍 [SIGNUP-PAGE] Attempting to navigate to /login')
                            console.log('🔍 [SIGNUP-PAGE] Current URL before navigation:', window.location.href)

                            try {
                                const result = router.push('/login')
                                console.log('🔍 [SIGNUP-PAGE] Router.push called, result:', result)
                                console.log('🔍 [SIGNUP-PAGE] Navigation initiated successfully')
                            } catch (error) {
                                console.error('🔍 [SIGNUP-PAGE] Error during navigation:', error)
                            }
                        }}
                        className="font-semibold leading-6 text-white bg-blue-500 hover:bg-blue-600 px-4 py-2 rounded-md transition-colors w-full"
                    >
                        Sign in instead
                    </button>
                </div>
            </div>
        </div>
    )
}