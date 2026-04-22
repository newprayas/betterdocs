'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import {
  checkSubscriptionStatus,
  clearSubscriptionCache,
  setupVisibilityChangeListener,
} from '@/services/subscriptionCheckService';
import {
  notifySubscriptionRefresh,
  redeemSubscriptionCode,
} from '@/services/subscriptionActionService';
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_REFRESH_EVENT,
  type SubscriptionStatus,
} from '@/utils/subscription';

export default function SubscriptionModal() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [isRedeeming, setIsRedeeming] = useState(false);
  const titleRef = useRef(null);

  const handleStatusUpdate = useCallback((nextStatus: SubscriptionStatus) => {
    setStatus(nextStatus);
    setOpen(!nextStatus.hasAccess);
  }, []);

  useEffect(() => {
    async function initialCheck() {
      const nextStatus = await checkSubscriptionStatus(true);
      if (nextStatus) {
        handleStatusUpdate(nextStatus);
      }
      setLoading(false);
    }

    initialCheck();

    const cleanupVisibility = setupVisibilityChangeListener(handleStatusUpdate);

    const handleRefresh = async () => {
      clearSubscriptionCache();
      const nextStatus = await checkSubscriptionStatus(true);
      if (nextStatus) {
        handleStatusUpdate(nextStatus);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener(SUBSCRIPTION_REFRESH_EVENT, handleRefresh);
    }

    return () => {
      cleanupVisibility();
      if (typeof window !== 'undefined') {
        window.removeEventListener(SUBSCRIPTION_REFRESH_EVENT, handleRefresh);
      }
    };
  }, [handleStatusUpdate]);

  const handleRedeemCode = async () => {
    const normalizedCode = redeemCode.trim();
    if (!normalizedCode || isRedeeming) {
      return;
    }

    setIsRedeeming(true);
    setRedeemError(null);

    try {
      const result = await redeemSubscriptionCode(normalizedCode);
      clearSubscriptionCache();

      if (!result.success || !result.status?.hasAccess) {
        setRedeemError(result.error || 'This code could not be used.');
        notifySubscriptionRefresh();
        return;
      }

      setRedeemCode('');
      handleStatusUpdate(result.status);
      notifySubscriptionRefresh();
    } catch (error) {
      setRedeemError(
        error instanceof Error ? error.message : 'This code could not be used.',
      );
    } finally {
      setIsRedeeming(false);
    }
  };

  if (loading) return null;

  const trialQueryLimit = status?.trialQueryLimit ?? 30;
  const trialQueriesUsed = status?.trialQueriesUsed ?? trialQueryLimit;
  const telegramSubscriptionLink =
    'https://t.me/meddyapp?text=' +
    encodeURIComponent('Can i get 3 months meddy subscription?');

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={() => {}} initialFocus={titleRef}>
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
              <Dialog.Panel className="relative transform overflow-hidden rounded-2xl bg-white px-4 pb-4 pt-5 text-left shadow-2xl transition-all sm:my-8 sm:w-full sm:max-w-2xl sm:p-8 border border-gray-200 dark:bg-slate-900 dark:border-slate-800">
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
                      Hey there, I'm Prayas
                    </Dialog.Title>

                    <div className="mt-4 space-y-4 text-left">
                      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                        It's awesome that you have been using the app and we are so happy you love it. We are grateful for your support.
                      </p>
                      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                        However, to keep this app running we need to pay some bills. Mainly the cost of building this app, monthly server costs to host this website, and API cost to provide your answers.
                      </p>
                      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                        We really wish we could keep this app as a free service, but these costs are unavoidable. We have to pay these companies to run our app, otherwise they will shut it down.
                      </p>
                      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                        Hence if you find this app useful and want it to continue existing, please consider subscribing for a small fee.
                      </p>

                      <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-800/30">
                        <p className="text-sm sm:text-base font-medium text-gray-800 dark:text-gray-200 leading-relaxed text-center">
                          Prices are less than a cup of coffee a month.
                          <br />
                          All the medical knowledge in the world in your pocket.
                        </p>
                      </div>

                      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                        Without your support we will sadly have to shut this app down for everyone.
                      </p>

                      <p className="text-sm sm:text-base font-medium text-gray-900 dark:text-white text-center mt-6">
                        Choose a plan:
                      </p>

                      <div className="mt-6 grid gap-4 sm:grid-cols-2">
                        {SUBSCRIPTION_PLANS.map((tier) => (
                          <div
                            key={tier.id}
                            className={`relative w-full p-4 rounded-xl border-2 transition-all ${
                              tier.id === '3 Months'
                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                                : 'border-gray-200 dark:border-slate-700'
                            }`}
                          >
                            {tier.id === '3 Months' && (
                              <span className="absolute -top-2 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                                BEST VALUE
                              </span>
                            )}
                            <div className="text-center">
                              <h4 className="font-semibold text-gray-900 dark:text-white">
                                {tier.name}
                              </h4>
                              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                {tier.duration}
                              </p>
                              <p className="mt-3 text-2xl font-bold text-lime-500 dark:text-lime-300">
                                ৳{tier.price}
                              </p>
                              {tier.savingsText && (
                                <p className="text-xs text-green-600 dark:text-green-400 font-medium mt-1">
                                  {tier.savingsText}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 bg-gray-50 dark:bg-slate-950/40 space-y-4">
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">
                          Simple steps:
                        </p>
                        <div className="space-y-3">
                          <div className="rounded-lg bg-white/80 dark:bg-slate-900/70 border border-gray-200 dark:border-slate-800 px-4 py-3">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">
                              1. Ask for a code in Telegram with your plan
                            </p>
                            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                              Example message: Can i get 3 months meddy subscription?
                            </p>
                            <a
                              href={telegramSubscriptionLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-3 inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-500"
                            >
                              Ask on Telegram
                            </a>
                          </div>

                          <div className="rounded-lg bg-white/80 dark:bg-slate-900/70 border border-gray-200 dark:border-slate-800 px-4 py-3">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">
                              2. Make payment via Bkash
                            </p>
                          </div>

                          <div className="rounded-lg bg-white/80 dark:bg-slate-900/70 border border-gray-200 dark:border-slate-800 px-4 py-3">
                            <p className="text-sm font-medium text-gray-900 dark:text-white">
                              3. Enter your code in the app
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 bg-gray-50 dark:bg-slate-950/40">
                        <label
                          htmlFor="subscription-code"
                          className="block text-sm font-medium text-gray-900 dark:text-white mb-2"
                        >
                          Enter your code
                        </label>
                        <div className="flex flex-col gap-3 sm:flex-row">
                          <input
                            id="subscription-code"
                            type="text"
                            value={redeemCode}
                            onChange={(event) => {
                              setRedeemCode(event.target.value.toUpperCase());
                              if (redeemError) setRedeemError(null);
                            }}
                            placeholder="Example: A7K2P9"
                            className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm uppercase tracking-[0.2em] text-gray-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={isRedeeming}
                          />
                          <button
                            type="button"
                            onClick={() => void handleRedeemCode()}
                            disabled={isRedeeming || !redeemCode.trim()}
                            className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isRedeeming ? 'Checking...' : 'Activate code'}
                          </button>
                        </div>
                        {redeemError && (
                          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                            {redeemError}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
