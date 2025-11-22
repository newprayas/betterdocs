'use client'

import { createClient } from '@/utils/supabase/client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const router = useRouter()
    const supabase = createClient()

    // Debug logging for component mount
    useEffect(() => {
        console.log('🔍 [LOGIN-PAGE] Component mounted, current path:', window.location.pathname)
        console.log('🔍 [LOGIN-PAGE] Router object available:', !!router)
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

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)
        setMessage(null)

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        })

        if (error) {
            setError(error.message)
        } else {
            router.push('/')
            router.refresh()
        }
        setLoading(false)
    }

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
                <h1 className="text-2xl font-bold text-white mb-2">Better Docs</h1>
                <p className="text-sm text-gray-400 mb-6">Made with ❤️ by Prayas</p>
                <h2 className="text-center text-xl font-semibold leading-9 tracking-tight text-white">
                    Have an account? <br /> ✨ Sign in ✨
                </h2>
            </div>

            <div className="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
                <form className="space-y-6" onSubmit={handleLogin}>
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
                        <div className="mt-2">
                            <input
                                id="password"
                                name="password"
                                type="password"
                                autoComplete="current-password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="block w-full rounded-md border-0 bg-white/5 py-1.5 text-white shadow-sm ring-1 ring-inset ring-white/10 focus:ring-2 focus:ring-inset focus:ring-indigo-500 sm:text-sm sm:leading-6"
                            />
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
                            {loading ? 'Loading...' : 'Sign in'}
                        </button>
                    </div>
                </form>

                <p className="mt-10 text-center text-sm text-blue-400">
                    Don't have an account already?
                </p>
                <div className="mt-4 text-center">
                    <button
                        type="button"
                        onClick={async () => {
                          console.log('🔍 [LOGIN-PAGE] "Make a New account" button clicked')
                          console.log('🔍 [LOGIN-PAGE] Current URL before navigation:', window.location.href)
                          console.log('🔍 [LOGIN-PAGE] Router object:', router)
                          console.log('🔍 [LOGIN-PAGE] Router.push function:', typeof router.push)
                          console.log('🔍 [LOGIN-PAGE] Window object available:', typeof window !== 'undefined')
                          console.log('🔍 [LOGIN-PAGE] Document object available:', typeof document !== 'undefined')
                          console.log('🔍 [LOGIN-PAGE] Router has push:', typeof router.push === 'function')
                          console.log('🔍 [LOGIN-PAGE] Router has replace:', typeof router.replace === 'function')
                          console.log('🔍 [LOGIN-PAGE] Router has prefetch:', typeof router.prefetch === 'function')
                          console.log('🔍 [LOGIN-PAGE] Router has back:', typeof router.back === 'function')
                          console.log('🔍 [LOGIN-PAGE] Router has forward:', typeof router.forward === 'function')
                          
                          try {
                            console.log('🔍 [LOGIN-PAGE] Starting navigation to /signup...')
                            const result = await router.push('/signup')
                            console.log('🔍 [LOGIN-PAGE] Router.push returned:', result)
                            console.log('🔍 [LOGIN-PAGE] Navigation promise resolved')
                          } catch (error) {
                            console.error('🔍 [LOGIN-PAGE] Navigation error:', error)
                          }
                          
                          // Check if navigation happened after multiple delays
                          setTimeout(() => {
                            console.log('🔍 [LOGIN-PAGE] 100ms after navigation, current URL:', window.location.href)
                            console.log('🔍 [LOGIN-PAGE] Current pathname:', window.location.pathname)
                          }, 100)
                          
                          setTimeout(() => {
                            console.log('🔍 [LOGIN-PAGE] 500ms after navigation, current URL:', window.location.href)
                            console.log('🔍 [LOGIN-PAGE] Current pathname:', window.location.pathname)
                          }, 500)
                          
                          setTimeout(() => {
                            console.log('🔍 [LOGIN-PAGE] 1000ms after navigation, current URL:', window.location.href)
                            console.log('🔍 [LOGIN-PAGE] Current pathname:', window.location.pathname)
                          }, 1000)
                        }}
                        className="font-semibold leading-6 text-indigo-400 hover:text-indigo-300 bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md transition-colors"
                    >
                        Make a New account 🎉
                    </button>
                </div>
            </div>
        </div>
    )
}
