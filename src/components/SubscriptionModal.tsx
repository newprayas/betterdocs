'use client'

import { Fragment, useState, useEffect, useRef } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { createClient } from '@/utils/supabase/client'

// Subscription pricing tiers - matches Supabase enum values
const SUBSCRIPTION_TIERS = [
    { id: '1 Month', name: '1 Month', duration: '1 month', price: 100, savings: 0 },
    { id: '3 Months', name: '3 Months', duration: '3 months', price: 250, savings: 50 },
    { id: '6 Months', name: '6 Months', duration: '6 months', price: 500, savings: 100 },
    { id: '12 Months', name: '12 Months', duration: '12 months', price: 800, savings: 400 },
]

// Plan duration in days - matches Supabase subscription_plan values
const PLAN_DURATIONS: Record<string, number> = {
    '1 Month': 30,
    '3 Months': 90,
    '6 Months': 180,
    '12 Months': 365,
}

export default function SubscriptionModal() {
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(true)
    const [daysRemaining, setDaysRemaining] = useState<number | null>(null)
    const supabase = createClient()
    const titleRef = useRef(null)

    useEffect(() => {
        async function checkSubscription() {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) {
                setLoading(false)
                return
            }

            const { data: profile } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single()

            if (profile) {
                const now = new Date()
                const trialStart = new Date(profile.trial_start_date)
                const trialEnd = new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 days
                const trialExpired = now > trialEnd

                // Check subscription using plan + start date (auto-calculates expiry)
                const isSubscribed = profile.is_subscribed
                const subscriptionPlan = profile.subscription_plan as string | null
                const subscriptionStartDate = profile.subscription_start_date
                    ? new Date(profile.subscription_start_date)
                    : null

                // Calculate subscription validity from plan + start date
                let subscriptionValid = false
                if (isSubscribed && subscriptionPlan && subscriptionStartDate) {
                    const planDays = PLAN_DURATIONS[subscriptionPlan] || 30
                    const subscriptionExpiry = new Date(subscriptionStartDate.getTime() + planDays * 24 * 60 * 60 * 1000)
                    subscriptionValid = now < subscriptionExpiry

                    // Calculate days remaining if valid
                    if (subscriptionValid) {
                        const diffTime = subscriptionExpiry.getTime() - now.getTime()
                        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
                        setDaysRemaining(diffDays)
                        console.log(`[SUBSCRIPTION] Valid: ${subscriptionPlan}, ${diffDays} days remaining`)
                    } else {
                        console.log(`[SUBSCRIPTION] Expired: ${subscriptionPlan}`)
                    }
                }

                // Show modal if:
                // 1. Trial has expired AND
                // 2. No valid subscription (either not subscribed or subscription expired)
                if (trialExpired && !subscriptionValid) {
                    setOpen(true)
                }
            }
            setLoading(false)
        }

        checkSubscription()
    }, [])

    if (loading) return null

    return (
        <Transition.Root show={open} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={() => { }} initialFocus={titleRef}>
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-gray-900/90 backdrop-blur-sm transition-opacity" />
                </Transition.Child>

                <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
                    <div className="flex min-h-full items-center justify-center p-4 text-center sm:p-0">
                        <Transition.Child
                            as={Fragment}
                            enter="ease-out duration-300"
                            enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                            enterTo="opacity-100 translate-y-0 sm:scale-100"
                            leave="ease-in duration-200"
                            leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                            leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                        >
                            <Dialog.Panel className="relative transform overflow-hidden rounded-2xl bg-white dark:bg-slate-900 px-4 pb-4 pt-5 text-left shadow-2xl transition-all sm:my-8 sm:w-full sm:max-w-2xl sm:p-8 border border-gray-200 dark:border-slate-800">
                                <div>
                                    <div className="mx-auto text-center mb-6">
                                        <span className="text-6xl animate-bounce inline-block">🥳</span>
                                    </div>
                                    <div className="mt-3 text-center sm:mt-5">
                                        <Dialog.Title
                                            as="h3"
                                            className="text-2xl font-bold leading-6 text-gray-900 dark:text-white mb-2 outline-none focus:outline-none focus:ring-0"
                                            ref={titleRef}
                                            tabIndex={-1}
                                        >
                                            Hey there!
                                        </Dialog.Title>
                                        <div className="mt-4 space-y-4 text-left">
                                            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                                                It's awesome that you have been using the app and we are so happy you love it. We are grateful for your support ❤️
                                            </p>
                                            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                                                However, to keep this app running we need to pay some bills - mainly the cost of building this app, monthly server costs to host this website, and API cost to provide your answers. We really wish we could keep this app as a free service (free is awesome!), but these costs are unavoidable - we have to pay these companies to run our app, which you are a part of now ✨
                                            </p>
                                            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                                                Hence if you find this app useful and want it to continue existing, please consider subscribing for a small fee.
                                            </p>
                                            <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-800/30">
                                                <p className="text-sm sm:text-base font-medium text-gray-800 dark:text-gray-200 leading-relaxed text-center">
                                                    🎉 <strong>Prices are 'less than a cup of coffee a month'</strong>
                                                    <br />
                                                    A small price for all the medical knowledge in the world in your pocket 🥳
                                                    <br />
                                                    ✨ Good Answers make Good Doctors ✨
                                                </p>
                                            </div>
                                            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                                                Without your support we will have to sadly shut this app down for everyone, users who love this app as much as you do 😔
                                            </p>
                                            <p className="text-sm sm:text-base font-medium text-gray-900 dark:text-white text-center mt-6">
                                                We have simplified the pricing plans for you:
                                            </p>

                                            {/* Pricing Tiers */}
                                            <div className="grid grid-cols-2 gap-3 mt-6">
                                                {SUBSCRIPTION_TIERS.map((tier) => (
                                                    <div
                                                        key={tier.id}
                                                        className={`
                                                            relative p-4 rounded-xl border-2 transition-all
                                                            ${tier.id === 'yearly'
                                                                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                                                                : 'border-gray-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600'
                                                            }
                                                        `}
                                                    >
                                                        {tier.id === 'yearly' && (
                                                            <span className="absolute -top-2 left-1/2 -translate-x-1/2 bg-indigo-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                                                                BEST VALUE
                                                            </span>
                                                        )}
                                                        <div className="text-center">
                                                            <h4 className="font-semibold text-gray-900 dark:text-white">
                                                                {tier.name}
                                                            </h4>
                                                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                                                {tier.duration}
                                                            </p>
                                                            <p className="mt-2 text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                                                                ৳{tier.price}
                                                            </p>
                                                            {tier.savings > 0 && (
                                                                <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                                                                    Save ৳{tier.savings}!
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>

                                            <p className="text-sm text-gray-500 dark:text-gray-400 text-center mt-4">
                                                Your support helps us keep the servers running and improve the app ❤️
                                            </p>
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-8 flex flex-col gap-3">
                                    <a
                                        href="https://t.me/prayas_ojha"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex w-full flex-col items-center justify-center rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-3.5 text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-purple-500 hover:shadow-indigo-500/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-all transform hover:-translate-y-0.5"
                                    >
                                        <span className="text-sm font-medium opacity-90 mb-0.5">To subscribe</span>
                                        <span className="text-lg font-bold">Contact us via Telegram</span>
                                    </a>
                                    <p className="text-sm text-center font-normal text-gray-900 dark:text-white mt-2">
                                        ✨ You can continue using the app as soon as you subscribe ✨
                                    </p>
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition.Root>
    )
}
