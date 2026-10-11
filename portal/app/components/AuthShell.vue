<template>
  <main class="grid min-h-screen bg-stone-50 lg:grid-cols-2 dark:bg-stone-950">
    <section class="hidden flex-col justify-between bg-sipper-900 p-14 text-white lg:flex">
      <SipperBrand />
      <div class="max-w-lg"><h1 class="text-4xl font-semibold leading-tight tracking-tight">Your people.<br>Their calling, sorted.</h1><p class="mt-6 text-lg leading-relaxed text-sipper-200">Manage calling accounts, devices and licences in one place.</p></div>
      <p class="text-sm text-sipper-200">One licence per person, across all their devices.</p>
    </section>
    <section class="flex items-center justify-center px-6 py-12"><div class="w-full max-w-md"><div class="mb-10 lg:hidden"><SipperBrand /></div><slot /></div></section>
  </main>
</template>
