'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function AuthCodeErrorContent() {
    const searchParams = useSearchParams();
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');
    const errorMessage = error || 'Unknown error';
    const errorDesc = errorDescription || 'An error occurred during authentication.';

    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-gray-900 px-6 py-12 lg:px-8">
            <div className="sm:mx-auto sm:w-full sm:max-w-sm text-center">
                <h2 className="mt-10 text-center text-2xl font-bold leading-9 tracking-tight text-white">
                    Authentication Error
                </h2>
                <p className="mt-4 text-gray-400">
                    There was an error verifying your email.
                </p>
                <div className="mt-4 rounded-md bg-red-900/50 p-4 text-red-200">
                    <p className="font-semibold">{errorMessage}</p>
                    {errorDesc && <p className="mt-2 text-sm">{errorDesc}</p>}
                </div>
                <div className="mt-10">
                    <Link
                        href="/login"
                        className="font-semibold leading-6 text-indigo-400 hover:text-indigo-300"
                    >
                        Back to Login
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default function AuthCodeError() {
    return (
        <Suspense fallback={
            <div className="flex min-h-screen flex-col items-center justify-center bg-gray-900">
                <div className="text-white">Loading...</div>
            </div>
        }>
            <AuthCodeErrorContent />
        </Suspense>
    );
}
