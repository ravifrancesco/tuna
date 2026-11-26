import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerInfo } from "@tuna/shared";
import { api, ApiError, onSignedOut } from "./api";
import { PillPlayer } from "./components/PillPlayer";
import { Resizer } from "./components/Resizer";
import { MenuHost, PlaylistPickerHost } from "./components/Menu";
import { Sidebar, Tabs } from "./components/Nav";
import { NowPlaying } from "./components/NowPlaying";
import { MiniPlayer } from "./components/PlayerBar";
import { shouldShowSplash, Splash } from "./components/Splash";
import { JoinRoom, TogetherSheetHost } from "./components/Together";
import { SleepSheetHost } from "./components/Sleep";
import { Empty, Toasts } from "./components/ui";
import { t } from "./i18n";
import {
  next,
  pause,
  play,
  previous,
  restore,
  stopAll,
  toggle,
} from "./lib/player";
import { setMe, useMe } from "./lib/session";
import { Album } from "./pages/Album";
import { Artist } from "./pages/Artist";
import { Getting } from "./pages/Getting";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { Login } from "./pages/Login";
import { Liked, Mix, Playlist } from "./pages/Playlist";
import { Profile } from "./pages/Profile";
import { Downloads } from "./pages/Downloads";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { WorldArtist } from "./pages/WorldArtist";
import { WorldAlbum } from "./pages/WorldAlbum";

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

function Shell() {
  const [now, setNow] = useState<{ tab?: "lyrics" | "queue" }>();
  const close = useCallback(() => setNow(undefined), []);
  const open = (tab?: "lyrics" | "queue") => setNow({ tab });
  // Going somewhere from the sidebar shows that page.
  const { pathname } = useLocation();
  useEffect(() => setNow(undefined), [pathname]);
  return (
    <div className="app">
      <Sidebar />
      <Resizer />
      <div className="right">
        <main className="main">
          <ScrollTop />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<Search />} />
            <Route path="/library" element={<Library />} />
            <Route path="/liked" element={<Liked />} />
            <Route path="/album/:id" element={<Album />} />
            <Route path="/artist/:id" element={<Artist />} />
            <Route path="/world/artist/:mbid" element={<WorldArtist />} />
            <Route path="/world/album/:mbid" element={<WorldAlbum />} />
            <Route path="/playlist/:id" element={<Playlist />} />
            <Route path="/mix/:id" element={<Mix />} />
            <Route path="/getting" element={<Getting />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/downloads" element={<Downloads />} />
            <Route path="/together/:id" element={<JoinRoom />} />
            <Route path="*" element={<Empty>{t("Not found")}</Empty>} />
          </Routes>
        </main>
        {!now && <PillPlayer onOpen={open} />}
        {now && <NowPlaying tab={now.tab} onClose={close} />}
      </div>
      {/* Phones: Now Playing covers the whole screen (older Android web views would draw these over it). */}
      {!now && <MiniPlayer onOpen={() => setNow({})} />}
      {!now && <Tabs />}
    </div>
  );
}

export function App() {
  const me = useMe();
  const qc = useQueryClient();
  const [server, setServer] = useState<ServerInfo>();
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<string>();
  // The opening animation, once a session; it also covers the start.
  const [opening, setOpening] = useState(shouldShowSplash);

  const start = useCallback(async () => {
    setProblem(undefined);
    try {
      const info = await api.server();
      setServer(info);
      if (info.ready) {
        const who = await api.me().catch((err) => {
          if (err instanceof ApiError && err.status === 401) return undefined;
          throw err;
        });
        setMe(who);
      }
    } catch {
      setProblem(t("Couldn't reach the Tuna server"));
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => void start(), [start]);
  useEffect(
    () =>
      onSignedOut(() => {
        stopAll();
        setMe(undefined);
      }),
    [],
  );
  useEffect(() => {
    if (me) void restore();
    else qc.clear();
  }, [me, qc]);
  useEffect(() => {
    // TV remotes' media keys.
    const media = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      ({ toggle, play, pause, next, previous })[what as "toggle"]?.();
    };
    window.addEventListener("tuna:media", media);
    return () => window.removeEventListener("tuna:media", media);
  }, []);

  return (
    <>
      {checked && page()}
      {(opening || !checked) && (
        <Splash
          ready={checked}
          quick={!opening}
          onDone={() => setOpening(false)}
        />
      )}
    </>
  );

  function page() {
    if (problem)
      return (
        <div className="center-page">
          <div className="signin">
            <p>{problem}</p>
            <button className="btn btn--primary" onClick={() => void start()}>
              {t("Try again")}
            </button>
          </div>
        </div>
      );
    if (server && !server.ready) return <Setup onDone={() => void start()} />;
    if (!me) return <Login onSignedIn={setMe} />;
    return (
      <BrowserRouter>
        <Shell />
        <MenuHost />
        <PlaylistPickerHost />
        <TogetherSheetHost />
        <SleepSheetHost />
        <Toasts />
      </BrowserRouter>
    );
  }
}
