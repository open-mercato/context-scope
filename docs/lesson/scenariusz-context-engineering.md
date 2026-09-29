# Context Engineering — scenariusz lekcji

> Ostatnia lekcja tygodnia. Prowadzący: Patryk Lewczuk (Open Mercato).
> Format: każda scena ma **Na ekranie** (co pokazujemy) i **Tekst** (co mówimy). Tekst jest pisany do mówienia, nie do czytania, więc zdania są krótkie.
> Narzędzia pokazywane w lekcji: Attention Lab, ContextScope (`npx contextscope`), Claude Code / Codex, skill `eliminate-no-op`.

---

## Wstęp i fundament

### Scena 1. Przywitanie

**Na ekranie:** kamera, plansza tytułowa „Context Engineering”.

**Tekst:**

Hej, przed tobą ostatnia lekcja w tym tygodniu. Tak się składa, że przed nami bardzo istotny wycinek całej konfiguracji pod agenty AI, czyli Context Engineering. Nazywam się Patryk Lewczuk i w Open Mercato odpowiadam między innymi za to, jak agenty czytają nasze repo.

To będzie lekcja trochę inna niż poprzednie. Mniej pisania nowych funkcji, więcej patrzenia agentowi przez ramię: co on właściwie widzi, kiedy pracuje w naszym projekcie, ile to kosztuje i co z tym zrobić.

### Scena 2. Co mamy z poprzednich lekcji

**Na ekranie:** drzewo repozytorium projektu kursowego; podświetlamy kolejno: `docs/` z wymaganiami, opis architektury i wzorców, `.github/workflows/`, katalog skilli.

**Tekst:**

Na tym etapie mamy już repozytorium z naszym projektem, zestaw wymagań, zdefiniowaną architekturę i wzorce projektowe, CI jako nasz safety net i wgrany katalog skilli. Czyli wszystko, czego potrzeba, żeby zacząć pracę nad kontekstem dla agentów kodujących.

Zwróć uwagę, że każda z tych rzeczy jest też kontekstem. Wymagania, architektura, skille — agent albo je przeczyta, albo nie. Albo przeczyta za dużo, albo za mało. Dziś zajmiemy się właśnie tym „albo”.

### Scena 3. Cele na tę lekcję

**Na ekranie:** plansza z trzema punktami celu.

**Tekst:**

W dzisiejszej lekcji mamy za zadanie zrozumieć, o co chodzi z tym całym Context Engineeringiem.

To, co będziemy starali się zrobić, to wybrać minimalny zestaw instrukcji, który w przejrzysty sposób opisuje to, czego potrzebuje agent. Nie „wszystko, co wiemy o projekcie”. Minimalny zestaw.

Konkretnie po tej lekcji będziesz umieć:

1. zmierzyć, co trafia do okna kontekstowego agenta w twoim projekcie — na starcie sesji i w trakcie pracy,
2. przebudować `AGENTS.md` w mały router, który wskazuje agentowi wiedzę dopiero wtedy, kiedy jest potrzebna,
3. dopiąć do CI checki, które pilnują, żeby ta konfiguracja się nie rozjechała.

### Scena 4. Czym jest Context Engineering

**Na ekranie:** cytat z Karpathy'ego / definicja na planszy.

**Tekst:**

Wiemy, że modele są coraz lepsze w kodowaniu i często wyzwaniem nie jest już ułożenie idealnego prompta. Ponieważ pracują autonomicznie dużo dłużej i wykonują coraz bardziej złożone zadania, najtrudniejsze staje się zarządzanie informacją, która dociera do ograniczonego mechanizmu uwagi modelu.

Context engineering, parafrazując trochę tweet Andreja Karpathy'ego, to projektowanie tego, co trafia do okna kontekstowego agenta, tak żeby były tam informacje, które są potrzebne teraz.

Prostszej definicji chyba nie ma, a oddaje sedno sprawy. W tej dziedzinie zarządzamy dostarczaniem informacji do okna kontekstowego, które, jak wszyscy wiemy, ma swoje limity. Musimy zadbać o to, żeby trafiały tam te dane, których agent właśnie potrzebuje do wykonania zadania.

Anthropic w swoim artykule o context engineeringu ujmuje to tak: szukamy najmniejszego zestawu tokenów o wysokim sygnale, który maksymalizuje szansę na oczekiwany wynik. Zapamiętaj te dwa słowa: najmniejszy i sygnał.

Wydaje się proste, ale jest wręcz przeciwnie. W dużych projektach to wyzwanie trochę jak zmieszczenie autobusu w maluchu.

### Scena 5. Po co to robimy

**Na ekranie:** dwie kolumny: „Jakość” i „Kasa”.

**Tekst:**

To po co się to właściwie robi? Wyróżniłbym dwa proste powody: jakość i kasę.

Jakość, czyli generowany kod robi to, co chcemy, i jest napisany zgodnie z naszymi wzorcami. Agent, który nie wie, gdzie jest nasz wzorzec walidacji, wymyśli własny. I zrobi to bardzo pewnie.

Kasa, czyli do wykonania zadania potrzeba jak najmniej tokenów. A tokeny to nie tylko rachunek. To też czas — każda niepotrzebna tura to kolejne sekundy — i to, jak szybko sesja dojdzie do kompakcji, po której agent zapomina część tego, co ustalił.

Jest już pierwsza twarda obserwacja z badań: w analizie 124 pull requestów z 10 repozytoriów samo posiadanie `AGENTS.md` wiązało się z o ok. 29% krótszym medianowym czasem pracy agenta i o ok. 17% mniejszą liczbą tokenów wyjściowych, przy podobnej skuteczności. To wczesne dane, a nie prawo natury, ale pokazują, że plik instrukcji to realna dźwignia, a nie kosmetyka.

### Scena 6. Context rot, czyli limit uwagi

**Na ekranie:** Attention Lab — suwak liczby tokenów, siatka połączeń uwagi między tokenami.

**Tekst:**

Pierwszy koncept, który musisz mieć w głowie: context rot.

Wraz ze wzrostem liczby tokenów w oknie kontekstowym spada zdolność modelu do trafnego przypominania sobie informacji z tego kontekstu. Niektóre modele degradują łagodniej, inne gwałtowniej, ale ta cecha pojawia się we wszystkich. Dlatego kontekst trzeba traktować jak zasób skończony, z malejącym zwrotem z każdego kolejnego tokena.

Skąd to się bierze? Pokażę ci to na Attention Lab.

*(przesuwamy suwak tokenów w górę)*

Każdy token w transformerze „patrzy” na każdy inny token. Przy dziesięciu tokenach to sto relacji. Przy stu — dziesięć tysięcy. Przy stu tysiącach tokenów liczba par rośnie kwadratowo i robi się z tego ocean. Model ma coś, co Anthropic nazywa budżetem uwagi, i każdy nowy token trochę ten budżet uszczupla. Plus model jest trenowany głównie na krótszych sekwencjach, więc z bardzo długimi zależnościami ma po prostu mniej doświadczenia.

Do tego dochodzi efekt „lost in the middle”: informacja z początku i z końca kontekstu jest wykorzystywana lepiej niż ta ze środka. Czyli twoja genialna reguła w linijce 340 pliku `AGENTS.md`, który jest przykryty czterdziestoma wynikami `grep`, ma niewielkie szanse.

Wniosek praktyczny: okno na milion tokenów to nie jest milion tokenów uwagi. To jest milion tokenów miejsca.

### Scena 7. Mapa: gdzie powstaje kontekst

**Na ekranie:** diagram osi czasu jednej sesji z czterema warstwami.

**Tekst:**

Żeby uprościć sobie myślenie o tym, jak projektować kontekst dla agenta, podzielimy pracę na cztery warstwy:

1. **Kontekst startowy** — to, co ląduje w oknie na starcie sesji, zanim napiszesz pierwsze słowo: system prompt, opisy narzędzi, schematy serwerów MCP, opisy skilli i `AGENTS.md` / `CLAUDE.md` z root katalogu.
2. **Kontekst z użycia skilli i narzędzi** — treść skilla, kiedy agent go uruchomi, wynik każdego wywołania narzędzia, output testów, lintera, buildu.
3. **Kontekst zbierany podczas szukania w kodzie** — tu kluczowe jest, czy agent musi dużo czytać, czy szybko znajdzie to, czego potrzebuje. Każdy `Read` całego pliku i każdy szeroki `grep` to tokeny.
4. **Kontekst w układzie agent główny + subagenci** — subagent ma własne, czyste okno, a do rodzica wraca tylko jego podsumowanie. Tu decydujemy, co zostaje w izolacji, a co wraca.

### Scena 8. Compile time vs run time

**Na ekranie:** dwie kolumny. Lewa: „Compile time — płacisz zawsze”. Prawa: „Run time — płacisz, kiedy potrzebujesz”.

**Tekst:**

Warto na te warstwy spojrzeć jak programista na kompilację.

**Compile time** to wszystko, co jest ustalone, zanim sesja ruszy: root `AGENTS.md`, opisy skilli, lista narzędzi, schematy MCP. To płacisz w każdym zapytaniu, w każdej sesji, niezależnie od tego, czy agent tego dziś potrzebuje. Dlatego tu każdy token musi na siebie zarobić.

**Run time** to wszystko, co agent dociąga w trakcie: treść skilla, zagnieżdżony `AGENTS.md` z katalogu modułu, plik dokumentacji wskazany przez router, wynik wyszukiwania. To płacisz tylko wtedy, kiedy zadanie tego wymaga.

Cała sztuka Context Engineeringu w repo sprowadza się do przesuwania wiedzy z lewej kolumny do prawej, zostawiając po lewej tylko to, co jest potrzebne naprawdę zawsze, oraz drogowskazy do reszty.

Na każdej z tych warstw jest sporo roboty. Ale zanim zaczniemy poprawiać to, jak dostarczamy kontekst, musimy rozpoznać, gdzie jesteśmy teraz i w których obszarach nasze działania przyniosą największą wartość. Nie optymalizujemy na czuja. Najpierw pomiar.

---

## Kontekst w naszym projekcie — AS IS

### Scena 9. Oglądamy, jak agent zbiera kontekst

**Na ekranie:** terminal w repo projektu. W Claude Code: `/context`. Potem `npx contextscope` i ekran Overview.

**Tekst:**

Zacznijmy od najprostszego narzędzia, które masz już w ręku. W Claude Code wpisuję `/context`.

*(pokazujemy rozbicie: system prompt, system tools, MCP tools, memory files, skills, messages, wolne miejsce)*

Widzisz? Zanim w ogóle cokolwiek zrobiłem, część okna jest zajęta. To jest nasz kontekst startowy, ten compile time z poprzedniej planszy.

Ale `/context` pokazuje mi jedną chwilę jednej sesji. Mnie interesuje coś więcej: co się działo w prawdziwych sesjach na tym repo przez ostatnie dni. Do tego użyję ContextScope, lokalnego narzędzia, które czyta transkrypty sesji zapisane przez Claude Code i Codex na dysku. Nic nie wychodzi z maszyny — ważne, bo transkrypty zawierają nasz kod.

```bash
npx contextscope
```

*(ekran Overview: lista sesji, zajętość okna per zapytanie, kompakcje)*

Na co patrzymy:

- **Startup / H0** — ile tokenów kosztuje nas samo otwarcie sesji w tym repo.
- **Wykres zajętości** — jak szybko rośnie kontekst i z czego się składa: instrukcje, wyniki narzędzi, argumenty narzędzi, wiadomości.
- **Kompakcje** — ile razy sesja dobiła do limitu i musiała się streścić.
- **Koszt per narzędzie** — które narzędzia zjadają najwięcej: `Read`, `Grep`, `Bash`, MCP.

*(otwieramy jedną, typową sesję — widok Session)*

Tu widzisz sesję zapytanie po zapytaniu. Ten skok to jeden `Read` całego pliku — prawie 20 tysięcy tokenów. Agent potrzebował z niego jednej funkcji. A ten schodek to kolejne szerokie `grep`, bo agent nie wiedział, gdzie szukać.

I to jest pierwszy, bardzo ważny wniosek: najwięcej tokenów zwykle nie idzie na nasze instrukcje. Idzie na szukanie. Agent czyta dużo, bo nie wie, gdzie co jest. Czyli dobre instrukcje to nie tylko „jak pisać kod”, ale przede wszystkim „gdzie szukać”.

```bash
npx contextscope scan
```

*(terminalowy raport: koszt per narzędzie, „one change first”, habits, findings)*

`scan` robi to samo w terminalu i na końcu podaje jedną zmianę, od której warto zacząć. Nie dziesięć. Jedną. Zapisujemy ją sobie — wrócimy do niej.

**Zadanie dla ciebie:** uruchom `/context` i `npx contextscope scan` na swoim projekcie i zapisz trzy liczby: koszt startu, typowy szczyt zajętości okna i liczbę kompakcji na sesję. To twój baseline.

### Scena 10. Skille — co za informacje niosą agentom

**Na ekranie:** katalog skilli z poprzedniej lekcji; jeden `SKILL.md` otwarty obok; w ContextScope ekran Setup z listą skilli i ich kosztem startowym.

**Tekst:**

Teraz skille. Pamiętasz, jak działają? To jest progressive disclosure w trzech poziomach:

1. **Metadane** — `name` i `description` z frontmattera. To ląduje w kontekście **zawsze**, na starcie każdej sesji, dla każdego zainstalowanego skilla. Compile time.
2. **Treść `SKILL.md`** — ładuje się dopiero, gdy agent uzna, że skill pasuje do zadania.
3. **Pliki dodatkowe** — `references/`, szablony, skrypty — czytane dopiero, gdy treść skilla na nie wskaże.

Z tego wynikają dwie rzeczy.

Po pierwsze: **opis skilla to jego jedyny interfejs**. Agent decyduje o użyciu skilla wyłącznie na podstawie opisu. Opis „Helper for backend stuff” nie uruchomi się nigdy albo zawsze. Opis „Use when adding a new API endpoint: creates route, validator, and integration test following our module pattern” uruchomi się wtedy, kiedy trzeba.

Po drugie: **dwadzieścia skilli to dwadzieścia opisów w każdej sesji**. Pojedynczo to mało, razem to już widać na wykresie startowym. Skill, którego nikt nie używa, nie jest darmowy.

*(w ContextScope, ekran Findings, filtr setup)*

Tu ContextScope pokazuje problemy w setupie: skill bez opisu, zły frontmatter, nazwa niezgodna z katalogiem. Duże badanie ponad 138 tysięcy publicznych skilli znalazło przynajmniej jedną wadę w ponad 90% z nich. Czyli prawie na pewno masz coś do poprawy.

Zadaj sobie przy każdym skillu trzy pytania:

- Czy z samego opisu wiem, **kiedy** go użyć?
- Czy treść mieści się na jednym ekranie, a szczegóły są w `references/`?
- Czy ktoś go w ogóle użył w ostatnich sesjach?

### Scena 11. Jak subagenci przychodzą nam na ratunek

**Na ekranie:** w ContextScope sesja z subagentami — tory (lanes) rodzica i dzieci, handoff ratio.

**Tekst:**

Wróćmy do problemu z poprzedniej sceny: szukanie zjada kontekst. Jedno z najskuteczniejszych rozwiązań to subagenci.

Subagent dostaje własne, czyste okno kontekstowe. Może przeczytać sto plików, zrobić dwadzieścia grepów, zużyć sto tysięcy tokenów — i to wszystko zostaje u niego. Do agenta głównego wraca tylko skondensowane podsumowanie, w dobrym przypadku tysiąc, dwa tysiące tokenów.

*(pokazujemy lane subagenta: szczyt np. 113k, handoff 2.6k)*

Spójrz: ten subagent Explore przejrzał ponad sto tysięcy tokenów kodu, a do rodzica oddał dwa i pół tysiąca. To jest kompresja ponad czterdziestokrotna. Główny agent dostał wniosek, a nie wszystkie pliki.

Ale uwaga, subagenci mają swoje pułapki i ContextScope je łapie:

- **Gruby handoff** — subagent zwraca cały transkrypt zamiast wniosków. Wtedy izolacja nie daje nic. Rozwiązanie: w definicji agenta albo w prompcie wprost „zwróć tylko ustalenia, ścieżki i linie, bez cytowania plików”.
- **Subagent czyta to, co rodzic już przeczytał** — bo rodzic nie przekazał mu, co wie. Rozwiązanie: w prompcie dla subagenta dawaj konkretne `plik:linia`, a nie „zbadaj moduł”.
- **Dwóch równoległych subagentów robi to samo** — bo dostali nakładające się zakresy. Rozwiązanie: rozłączne zakresy w promptach.

Reguła kciuka: eksploracja, research, przegląd dużego obszaru — do subagenta. Edycja, która wymaga pełnego obrazu decyzji z rozmowy — w agencie głównym.

---

## Kontekst w dużym projekcie, czyli jak zmieścić autobus w maluchu

### Scena 12. Poprawiamy AGENTS.md i budujemy strukturę plików

**Na ekranie:** obecny, długi `AGENTS.md` projektu; obok licznik tokenów z ContextScope Setup.

**Tekst:**

Mamy pomiar, to bierzemy się za robotę. Zaczynamy od root `AGENTS.md`, bo to jest najdroższy plik w repo — płacimy za niego w każdym zapytaniu każdej sesji.

Typowy `AGENTS.md` po kilku tygodniach wygląda tak: coś się raz zepsuło, dopisaliśmy regułę. Agent coś źle nazwał, dopisaliśmy regułę. Każda z tych linijek zasłużyła na swoje miejsce w dniu, w którym ją dopisaliśmy. Problem jest kumulatywny.

Pierwsza rzecz: **wyrzucamy no-opy**. No-op to instrukcja, która kosztuje tokeny, ale nie zmienia zachowania agenta:

- „Pisz czysty, czytelny kod” — agent i tak tak próbuje. No-op.
- „Jesteś doświadczonym programistą” — no-op.
- „Używaj TypeScriptu” — w repo z `tsconfig.json` i samymi plikami `.ts`. No-op, agent to widzi.
- Kopia dokumentacji frameworka, którą model zna — no-op.

Do tego audytu używam skilla `eliminate-no-op`: przechodzi przez plik instrukcji, oznacza każdą regułę, która nie zmienia zachowania, i proponuje przepisaną wersję. Nie przyjmuję wszystkiego w ciemno, ale lista kandydatów do wycięcia jest bardzo pouczająca.

Druga rzecz: **właściwa wysokość**, jak nazywa to Anthropic. Instrukcja może być za nisko — sztywny `if-else` na każdą sytuację, kruchy i drogi w utrzymaniu. Może być za wysoko — ogólniki, które zakładają, że agent zna nasz kontekst. Szukamy środka: konkretne heurystyki i konkretne miejsca w repo.

Trzecia rzecz: **root `AGENTS.md` staje się routerem**. Zostaje w nim tylko to, co jest potrzebne w każdym zadaniu:

- czym jest projekt, w dwóch zdaniach,
- komendy: instalacja, testy, lint, build — dokładnie te, które działają,
- mapa repo: gdzie co jest,
- twarde reguły, których złamanie jest drogie,
- tabela routingu: jeśli robisz X, przeczytaj Y.

Wszystko inne wyjeżdża do plików, które agent czyta dopiero wtedy, kiedy ma zadanie z danego obszaru.

**Na ekranie:** struktura docelowa.

```text
AGENTS.md                      # router: ~100–150 linii, zawsze w kontekście
CLAUDE.md -> AGENTS.md         # jedna prawda dla wielu narzędzi (symlink albo @AGENTS.md)
.agents/
  rules/                       # stałe reguły obszarowe (testy, bezpieczeństwo, migracje)
  context/                     # wiedza referencyjna: schemat bazy, kontrakty API
  memory/                      # decyzje, które mogą się zmienić: "wybraliśmy X, bo Y"
  specs/                       # wymagania bieżącego zadania, archiwizowane po zakończeniu
src/modules/<moduł>/AGENTS.md  # lokalne reguły modułu, ładowane przy pracy w tym katalogu
```

**Tekst:**

To jest układ inspirowany standardem `.agents`, o którym pisze Jeff Mixon. Dwa rozróżnienia z tego standardu warto przyjąć, nawet jeśli nie bierzesz całości:

- **Reguła vs pamięć** — reguła to „zawsze uruchamiaj testy przed commitem”. Pamięć to „wybraliśmy Postgresa ze względu na JSONB”. Reguły się egzekwuje, pamięć się aktualizuje.
- **Context vs spec** — context jest trwały i wspólny dla wielu zadań. Spec dotyczy jednego zadania i po jego zakończeniu przestaje obowiązywać. Stary spec w kontekście to trucizna: agent będzie realizował wymagania sprzed miesiąca.

Zagnieżdżone `AGENTS.md` w katalogach modułów to najtańszy just-in-time, jaki istnieje: Codex łączy je według ścieżki, a Claude Code dociąga zagnieżdżony `CLAUDE.md`, kiedy zaczyna pracować w danym katalogu. Dla Claude Code masz jeszcze `.claude/rules/*.md` z polem `paths:` we frontmatterze — reguła ładuje się tylko przy plikach pasujących do wzorca.

### Scena 13. Struktura projektu i naming convention

**Na ekranie:** dwa drzewa katalogów obok siebie: „chaos” (`utils2.ts`, `helpers/`, `new-service.ts`) i „sygnał” (`modules/orders/api/`, `modules/orders/data/`, `*.test.ts` obok źródła).

**Tekst:**

Teraz coś, co nie jest instrukcją, a działa jak instrukcja. Anthropic pisze wprost: hierarchia folderów, konwencje nazewnictwa i znaczniki czasu to ważne sygnały, które pomagają zarówno ludziom, jak i agentom zrozumieć, jak i kiedy korzystać z informacji.

Agent, który widzi `tests/test_utils.py`, wie coś innego niż agent, który widzi `src/core_logic/test_utils.py`. Nie musi czytać zawartości, żeby wyciągnąć wnioski. Nazwa pliku to jest darmowy kontekst.

Praktycznie:

- **Przewidywalna struktura modułów.** Jeżeli każdy moduł ma ten sam układ — `api/`, `data/`, `ui/`, `AGENTS.md` — agent po przeczytaniu jednego modułu umie poruszać się po wszystkich. Wzorzec zamiast opisu.
- **Nazwy, które da się wygrepować.** `OrderValidator` zamiast `validate.ts` w pięciu miejscach. Unikalne nazwy to krótkie wyniki wyszukiwania.
- **Testy obok kodu albo w lustrzanej strukturze.** Agent od razu wie, gdzie dopisać test.
- **Daty i statusy w dokumentach.** `docs/adr/2026-09-01-auth-provider.md` ze statusem `Accepted` albo `Superseded`. Agent nie wdroży decyzji, która została już odwołana.
- **Mniejsze pliki.** Plik na 3000 linii to 30 tysięcy tokenów przy każdym pełnym odczycie. Podział na mniejsze pliki to nie tylko czystość kodu, to wprost oszczędność kontekstu.

Nie musisz tego robić w jeden dzień. Ale każdą nową rzecz w projekcie nazywaj tak, jakby miał ją znaleźć ktoś, kto widzi repo pierwszy raz. Bo agent widzi je pierwszy raz w każdej sesji.

### Scena 14. Dla LLM-a przykłady są „obrazkami” wartymi tysiąca słów

**Na ekranie:** dwie wersje reguły. Po lewej akapit opisu. Po prawej trzy linijki: „Wzorcowy endpoint: `src/modules/orders/api/create-order.ts`”.

**Tekst:**

Kolejna rzecz prosto z artykułu Anthropic: dla LLM-a przykłady to obrazki warte tysiąca słów.

Możesz napisać w `AGENTS.md` dwa akapity o tym, jak u nas wygląda endpoint: walidacja na wejściu, serwis, mapowanie błędów, test integracyjny. Albo możesz napisać jedną linijkę: „Nowy endpoint twórz na wzór `src/modules/orders/api/create-order.ts` i jego testu”.

Druga wersja jest krótsza, dokładniejsza i nigdy się nie zdezaktualizuje względem kodu, bo *jest* kodem.

Zasady dobrych przykładów:

- **Kanoniczne, nie wyczerpujące.** Jeden, dwa wzorcowe pliki na typ zadania. Nie lista czterdziestu przypadków brzegowych.
- **Wskazanie, a nie wklejenie.** Ścieżka do pliku kosztuje dziesięć tokenów. Wklejony plik kosztuje tysiąc i zestarzeje się przy pierwszym refaktorze.
- **Przykład musi być naprawdę wzorcowy.** Agent skopiuje wszystko, łącznie z błędami. Jeśli wskazujesz plik jako wzór, zadbaj, żeby był najlepszym plikiem swojego typu w repo.

### Scena 15. Task Driven Context Routing, czyli Just in Time Context

**Na ekranie:** gotowy root `AGENTS.md` projektu z tabelą routingu.

**Tekst:**

Składamy to w całość. Just in time context według Anthropic to podejście, w którym agent nie dostaje wszystkiego z góry, tylko trzyma lekkie identyfikatory — ścieżki do plików, zapytania, linki — i dociąga dane wtedy, kiedy ich potrzebuje. Dokładnie tak, jak my: nie uczymy się całego repo na pamięć, tylko wiemy, gdzie szukać.

W repo robimy to tabelą routingu opartą na zadaniach.

```markdown
# <Nazwa projektu>

Aplikacja do <jedno zdanie o domenie>. Monorepo: `apps/web` (UI), `apps/api` (backend), `packages/shared`.

## Komendy
- Instalacja: `npm ci`
- Testy modułu: `npm test -- <ścieżka>` (pełny zestaw tylko przed PR: `npm test`)
- Lint + typy: `npm run check`

## Twarde reguły
- Nie edytuj plików w `migrations/` po ich zmergowaniu — dodaj nową migrację.
- Sekrety tylko z `process.env`; nowe zmienne dopisz do `.env.example`.

## Routing zadań
| Jeśli zadanie dotyczy... | Najpierw |
|---|---|
| nowego endpointu API | PRZECZYTAJ `.agents/rules/api.md`, wzór: `apps/api/src/modules/orders/create-order.ts` |
| schematu bazy / migracji | PRZECZYTAJ `.agents/context/schema.md`, URUCHOM `npm run db:diff` |
| komponentów UI | PRZECZYTAJ `apps/web/AGENTS.md` |
| autoryzacji | PRZECZYTAJ `.agents/memory/auth-decisions.md` |
| bieżącej funkcjonalności z backlogu | PRZECZYTAJ spec w `.agents/specs/` o tej nazwie |
| szerokiego rozpoznania kodu | DELEGUJ do subagenta Explore; zwrot: ścieżki + wnioski |
```

**Tekst:**

Zwróć uwagę na czasowniki: PRZECZYTAJ, URUCHOM, DELEGUJ. To podpatrzone ze standardu `.agents`. Sama informacja „jest plik X” jest słaba — agent nie wie, co ma z nią zrobić. Warunek plus czasownik plus ścieżka to instrukcja, która faktycznie zmienia zachowanie.

I dwie zasady, żeby router nie urósł z powrotem:

- **Nie odtwarzaj monolitu piętro niżej.** Jeśli `.agents/rules/api.md` ma 800 linii, przenieśliśmy problem, a nie go rozwiązaliśmy. Każdy plik docelowy też ma być mały i sam może routować dalej.
- **Hybryda, nie dogmat.** Rzeczy potrzebne w prawie każdym zadaniu — komendy, mapa repo — zostają w routerze na stałe. Anthropic nazywa to strategią hybrydową: trochę kontekstu z góry dla szybkości, reszta w trakcie dla elastyczności.

**Na ekranie:** `npx contextscope experiment start router` → edycja → `candidate router` → `compare router`.

**Tekst:**

A teraz najważniejsze: sprawdzamy, czy to zadziałało. ContextScope ma do tego `experiment`: robi snapshot łańcucha instrukcji przed zmianą, potem po zmianie i porównuje sesje sprzed i po. Uczciwie mówi też, że to obserwacja — różne sesje to różne zadania — i nie maluje delty na zielono, jeśli danych jest za mało. To zdrowe podejście: nie ogłaszamy sukcesu po jednej sesji.

### Scena 16. Skille — gdzie można przyoszczędzić na kontekście

**Na ekranie:** jeden rozbudowany skill przed i po refaktorze.

**Tekst:**

Wracamy do skilli, tym razem z nożyczkami.

1. **Skróć opisy, ale doprecyzuj triggery.** Opis ma powiedzieć, kiedy użyć skilla, a nie opowiadać, jaki jest wspaniały. Jedno, dwa zdania plus konkretne frazy wyzwalające.
2. **`SKILL.md` na jeden ekran.** Model mentalny i główny przepływ. Szczegóły, tabele, długie przykłady — do `references/`, czytane tylko wtedy, gdy krok ich wymaga.
3. **Skrypty zamiast prozy.** Jeśli skill opisuje w dziesięciu krokach, jak wygenerować plik, zamień te kroki na skrypt w `scripts/`. Agent uruchamia skrypt i widzi tylko wynik — treść skryptu nie musi w ogóle trafić do kontekstu.
4. **Usuń nieużywane.** Skill, który od miesiąca się nie uruchomił, płaci czynsz w każdej sesji. Wyłącz go w tym projekcie albo przenieś na poziom użytkownika u osoby, która go potrzebuje.
5. **Nie duplikuj reguł między skillem a `AGENTS.md`.** Jedna kopia, w drugim miejscu wskaźnik. Duplikaty to dwa razy tokeny i ryzyko, że rozjadą się w treści, a wtedy agent dostaje sprzeczne polecenia.

To samo dotyczy serwerów MCP, i to nawet mocniej: schematy narzędzi MCP potrafią ważyć tysiące tokenów i są w każdym zapytaniu. Serwer skonfigurowany, a nieużywany w ostatnich sesjach — ContextScope oznacza go jako habit H-06 — wyłączamy dla projektu. Anthropic ujmuje to tak: jeśli człowiek nie potrafi jednoznacznie powiedzieć, którego narzędzia użyć w danej sytuacji, agent też nie będzie potrafił. Mniej, wyraźniej rozgraniczonych narzędzi to lepsze decyzje.

### Scena 17. Skrypty, tool calle i hooki, czyli jak determinizm może nas wspierać

**Na ekranie:** `.claude/settings.json` z hookami i krótki skrypt.

**Tekst:**

Do tej pory wszystko, co robiliśmy, było probabilistyczne. Piszemy instrukcję i liczymy, że agent ją zastosuje. Ale część reguł nie musi być prośbą. Może być mechanizmem.

Prosta zasada: **jeśli regułę da się sprawdzić programem, nie pisz jej prozą w `AGENTS.md`**. Formatowanie — prettier. Importy — lint. Typy — kompilator. Zakazany katalog — hook. Wtedy instrukcja znika z kontekstu, a reguła jest egzekwowana w stu procentach, a nie w dziewięćdziesięciu.

Trzy narzędzia deterministyczne:

**Skrypty** — zamiast opisywać procedurę, dajesz komendę. `npm run db:diff` zamiast akapitu o tym, jak porównać schemat. Skrypt powinien drukować mało, a przy błędzie konkretnie: który plik, która linia, co zrobić.

**Tool calle** — narzędzia, które zwracają zwięzły wynik. `grep` z limitem, czytanie zakresu linii zamiast całego pliku, testy odpalane dla modułu, a nie dla całego repo. Wynik narzędzia to kontekst, więc projektujemy go tak samo starannie jak instrukcje.

**Hooki** — kod, który harness uruchamia sam, w określonych momentach: przed i po wywołaniu narzędzia, na starcie sesji, przy wysłaniu promptu, przed kompakcją.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": ".claude/hooks/check-changed-file.sh" }]
      }
    ]
  }
}
```

```bash
#!/usr/bin/env bash
# .claude/hooks/check-changed-file.sh
file=$(jq -r '.tool_input.file_path // empty')
[[ "$file" =~ \.(ts|tsx)$ ]] || exit 0
out=$(npx eslint --max-warnings=0 "$file" 2>&1) && exit 0
echo "$out" | head -20 >&2   # tylko pierwsze 20 linii trafia do agenta
exit 2                        # kod 2 = błąd wraca do agenta jako feedback
```

**Tekst:**

I tu dochodzimy do słowa, które jest dla mnie kluczem do tej sceny: **feedback loop**.

Agent pisze kod, hook od razu uruchamia lint na zmienionym pliku, a jeśli coś jest nie tak, zwraca agentowi krótki, konkretny błąd. Agent poprawia. Nie my, nie w review, nie w CI po dwudziestu minutach. W tej samej turze.

Dwie pułapki:

- **Hook, który dużo mówi.** Jeśli hook drukuje 300 linii przy każdym zapisie pliku, zrobiłeś właśnie generator context rotu. Hook ma milczeć przy sukcesie i mówić krótko przy błędzie. Stąd to `head -20` w skrypcie.
- **Zmienny output na początku kontekstu.** Hook `SessionStart`, który wstrzykuje np. aktualną godzinę, psuje cache promptu, bo prefiks jest za każdym razem inny. ContextScope łapie to jako cache churn. Na początek kontekstu dawaj rzeczy stabilne.

---

## Wzbogacamy nasz safety net o checki pod Context Engineering

### Scena 18. Jak zadbać, żeby cała konfiguracja się nie rozjeżdżała

**Na ekranie:** `.contextscope.json`, workflow w `.github/workflows/`, wynik `contextscope check` w terminalu i jako adnotacje w PR.

**Tekst:**

Mamy ładny router, małe skille, hooki. Za miesiąc ktoś zmieni nazwę katalogu, router będzie wskazywał nieistniejący plik, ktoś dopisze do `AGENTS.md` trzysta linijek „na szybko” i jesteśmy z powrotem w punkcie wyjścia. Konfiguracja kontekstu gnije tak samo jak kod, tylko ciszej, bo żaden test jej nie łapie.

Więc łapiemy ją testem. Konfiguracja kontekstu to kod — dostaje swój gate w CI.

```json
{
  "budgets": { "startupTokens": 6000, "instructionFileTokens": 3000 },
  "failOn": "high",
  "ignore": ["tests/fixtures/**"]
}
```

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx contextscope check --fail-on high --github
```

**Tekst:**

`contextscope check` nie czyta żadnych sesji, tylko sam setup w repo, więc na laptopie i na runnerze daje ten sam wynik, w mniej niż sekundę. Co pilnuje:

- **Budżet startowy** — ile tokenów kosztuje otwarcie sesji: instrukcje, skille, agenci, schematy MCP. Przekroczenie budżetu blokuje PR. To jest ten compile time, który chcemy trzymać w ryzach.
- **Budżet na pojedynczy plik instrukcji** — żaden plik nie może urosnąć ponad limit.
- **Martwe odwołania** — router wskazuje ścieżkę, której nie ma. To najczęstszy sposób, w jaki just-in-time się psuje: agent idzie do pliku, pliku nie ma, zaczyna szukać po całym repo.
- **Duplikaty** — ten sam blok instrukcji w dwóch plikach.
- **Skille** — brak opisu, zły frontmatter, nazwa niezgodna z katalogiem.
- **Nieaktualne instrukcje** — plik instrukcji starszy niż struktura katalogu, który opisuje.

Z flagą `--github` błędy pokazują się jako adnotacje bezpośrednio w PR, przy pliku.

Do tego trzy praktyki, których nie da się w pełni zautomatyzować:

1. **Zmiana w instrukcjach to zmiana jak każda inna** — idzie przez PR, a w opisie PR podajemy, jakie zachowanie agenta ma zmienić. Jeśli nie umiesz tego napisać, to prawdopodobnie no-op.
2. **Jedna prawda dla wielu narzędzi** — `CLAUDE.md` jako symlink do `AGENTS.md` albo import `@AGENTS.md`. Dwa ręcznie utrzymywane pliki rozjadą się w ciągu tygodnia.
3. **Okresowy przegląd na danych** — raz na sprint `npx contextscope scan`: habits pokazują powtarzające się problemy między sesjami, na przykład ten sam plik czytany w całości w każdej sesji. To sygnał, że wiedza z tego pliku powinna mieć skrót w routerze.

---

## Dynamic Context

### Scena 19. Kontekst, który zmienia się w trakcie sesji

**Na ekranie:** wykres zajętości długiej sesji z zaznaczonymi kompakcjami; obok lista mechanizmów.

**Tekst:**

Na koniec warstwa, która dzieje się sama, jeśli jej nie zaprojektujemy: kontekst dynamiczny. Wszystko, co do tej pory robiliśmy, dotyczyło tego, co w repo. Ale sesja żyje i jej kontekst zmienia się z każdą turą.

Anthropic opisuje trzy techniki dla długich zadań i każda ma swoje odpowiedniki w naszej codziennej pracy.

**1. Kompakcja.** Gdy okno się zapełnia, rozmowa jest streszczana, a streszczenie zaczyna nowe okno. Problem: streszczenie gubi szczegóły, a my nie wiemy które. Co możemy zrobić:

- kompaktować świadomie, z fokusem, na końcu fazy zadania — np. `/compact zachowaj decyzje o schemacie i listę plików do zmiany` — zamiast czekać, aż automat zadziała w środku edycji,
- częściej zaczynać nową sesję na nowe zadanie niż ciągnąć jedną przez cały dzień. Wznowiona sesja płaci za całą poprzednią historię w każdym zapytaniu,
- najtańsza forma kompakcji to czyszczenie wyników narzędzi: stary wynik `grep` sprzed trzydziestu tur nie jest już potrzebny.

**2. Notatki strukturalne, czyli pamięć agenta.** Agent zapisuje postęp i decyzje poza oknem — w pliku `NOTES.md`, w `.agents/memory/`, w liście zadań — i czyta je, kiedy ich potrzebuje. W artykule Anthropic jest przykład Claude'a grającego w Pokémona, który przez tysiące kroków gry prowadzi własne notatki i dzięki nim nie gubi celu. U nas to może być prościej: na końcu zadania agent zapisuje handoff — co zrobione, co zostało, jakie decyzje — a następna sesja zaczyna od przeczytania tego pliku, a nie od odkrywania wszystkiego od nowa.

Uważaj tylko na jedną rzecz: pamięć też gnije. Notatka „używamy biblioteki X”, która od dwóch tygodni nie jest prawdą, jest gorsza niż brak notatki. Pamięć wymaga dat i sprzątania.

**3. Subagenci jako zawór bezpieczeństwa.** Wracamy do sceny 11. W długiej sesji każde szerokie rozpoznanie delegujemy, żeby okno agenta głównego zostało na decyzje i edycje.

I czwarta rzecz, specyficzna dla agentów kodujących: **hooki wstrzykujące kontekst**. Hook `SessionStart` może na starcie sesji dodać aktualny branch, listę zmienionych plików albo spec zadania przypisanego do brancha. Hook `UserPromptSubmit` może na podstawie treści prompta dorzucić właściwy plik reguł. To jest routing zadań zrobiony deterministycznie, a nie przez to, że agent sam przeczyta tabelę. Potężne narzędzie — i dokładnie z tego powodu trzeba go używać oszczędnie, bo wszystko, co wstrzykniesz, ląduje w kontekście bez pytania.

### Scena 20. Podsumowanie

**Na ekranie:** plansza z checklistą.

**Tekst:**

Podsumujmy. Context engineering to nie jest pisanie dłuższych instrukcji. To jest decydowanie, czego agent **nie** zobaczy, dopóki tego nie potrzebuje.

Checklista na ten tydzień:

- [ ] Zmierz baseline: koszt startu, szczyt okna, kompakcje na sesję (`/context`, `npx contextscope scan`).
- [ ] Przejdź root `AGENTS.md` skillem `eliminate-no-op` i wytnij instrukcje, które nie zmieniają zachowania.
- [ ] Zamień root `AGENTS.md` w router: komendy, mapa, twarde reguły, tabela routingu z czasownikami.
- [ ] Przenieś wiedzę obszarową do zagnieżdżonych `AGENTS.md` i `.agents/{rules,context,memory,specs}`.
- [ ] Zastąp opisy wzorców wskazaniem na wzorcowe pliki.
- [ ] Popraw opisy skilli, odchudź `SKILL.md`, wyłącz nieużywane skille i serwery MCP.
- [ ] Zamień reguły, które da się sprawdzić programem, na lint, skrypty i hooki z krótkim feedbackiem.
- [ ] Dodaj `contextscope check` do CI z budżetami.
- [ ] Po tygodniu porównaj sesje przed i po (`contextscope experiment compare`).

Najważniejsze zdanie z tej lekcji: okno kontekstowe to nie magazyn, to biurko. Na biurku leży tylko to, nad czym właśnie pracujesz. Reszta jest w szafie, w dobrze opisanych szufladach, a agent wie, która szuflada jest od czego.

Dzięki, że dotrwałeś do końca tygodnia. Do zobaczenia w kolejnym module.

---

## Materiały i źródła

- Anthropic, *Effective context engineering for AI agents* — context rot, budżet uwagi, „właściwa wysokość” system promptu, przykłady jako „obrazki”, just-in-time context, strategia hybrydowa, kompakcja, notatki strukturalne, subagenci: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Jeff Mixon, *dotagents-standard skill* — standard `.agents/` (rules / context / memory / personas / skills / specs / logs), router z czasownikami akcji, progressive disclosure w samym skillu: https://www.jeffmixon.com/post/dotagents-standard-agent-skill/
- 10xDevs, lekcja w module 3: https://bravecourses.circle.so/c/lekcje-10x3/sections/966240/lessons/3662412 — *uwaga: strona wymaga logowania i nie została przeczytana przy tworzeniu scenariusza; przed nagraniem sprawdź spójność nazewnictwa i odwołań z poprzednimi lekcjami.*
- Liu i in., *Lost in the Middle*: https://arxiv.org/abs/2307.03172
- Chroma, *Context Rot*: https://www.trychroma.com/research/context-rot
- *Impact of AGENTS.md on coding-agent efficiency* (124 PR, 10 repo): https://arxiv.org/abs/2601.20404
- *What Keeps Agent Skills from Being Reusable?* (138 133 skille): https://arxiv.org/abs/2608.08453
- Claude Code: subagenci https://code.claude.com/docs/en/subagents, hooki https://code.claude.com/docs/en/hooks, okno kontekstowe https://code.claude.com/docs/en/context-window
- ContextScope (to repo): `packages/cli/README.md` — `scan`, `check`, `experiment`, `hooks`; reguły S-* (setup), B-* (sesje), H-* (nawyki między sesjami) w `packages/cli/src/rules/`; research w `docs/context-engineering-research.md`.

## Notatki produkcyjne

- **Przed nagraniem:** przygotuj repo projektu kursowego z „brudnym” `AGENTS.md` (min. 300 linii, kilka no-opów, jedno martwe odwołanie, jeden zduplikowany blok) oraz kilkoma sesjami w historii, żeby ContextScope miał co pokazać. Zapisz baseline z `scan` jako plik — w scenie 15 porównujemy do niego.
- **Attention Lab (scena 6):** zacznij od ~10 tokenów, skończ na maksimum suwaka; zatrzymaj się na moment, kiedy siatka staje się nieczytelna — to jest puenta.
- **Demo checka (scena 18):** celowo zmień nazwę katalogu wskazywanego w routerze i pokaż czerwony `check` z adnotacją w PR, potem napraw.
- **Liczby w scenach 9 i 11** (20k przy `Read`, 113k → 2.6k handoff) podmień na wartości z własnego nagrania, żeby tekst zgadzał się z ekranem.
