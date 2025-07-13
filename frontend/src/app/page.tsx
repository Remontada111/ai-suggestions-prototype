'use client';                           // Gör sidan till en klient-komponent – krävs eftersom Menu
                                        // innehåller interaktiva React-element (ikoner, ev. knappar).

import { Menu } from './menu';   // <-- justera sökvägen om du lagt Menu.tsx på annat ställe

export default function Page() {
  return (
    // Hela fönstret delas upp i två kolumner: sidebar (fix bredd) + huvudyta (flex-1)
    <div className="flex min-h-screen">
      {/* SIDEBAR  */}
      <aside className="w-64">          {/* 64 = 16rem ≈ 256 px – ändra vid behov */}
        <Menu />
      </aside>

      {/* HUVUDINNEHÅLL  */}
      <main className="flex-1 flex items-center justify-center">
        <h1 className="text-4xl font-bold text-emerald-500">
          Tailwind fungerar!
        </h1>
      </main>
    </div>
  );
}
