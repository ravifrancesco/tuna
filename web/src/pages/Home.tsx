import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { api } from '../api';
import { HomeRow } from '../components/Cards';
import { HomeHero } from '../components/HomeHero';
import { ProfileButton } from '../components/Profile';
import { TogetherRow } from '../components/Together';
import { Empty, Spinner } from '../components/ui';
import { t } from '../i18n';

export function Home() {
  const home = useQuery({ queryKey: ['home'], queryFn: api.home, staleTime: 60_000 });
  if (home.isLoading) return <Spinner />;
  if (!home.data) return <Empty>{t("Couldn't load your music")}</Empty>;
  const { greeting, rows } = home.data;
  return (
    <div className="page">
      <div className="home-head">
        <h1 className="hello">{greeting}</h1>
        <div className="home-head__end">
          <div className="mobile-only">
            <Link className="icon-btn" to="/getting" aria-label={t('On its way')}>
              <Activity size={22} />
            </Link>
          </div>
          <ProfileButton />
        </div>
      </div>
      <TogetherRow />
      <HomeHero home={home.data} />
      {rows.map((row) => (
        <HomeRow key={row.id} row={row} />
      ))}
      {!rows.length && <Empty>{t('Your library is empty')}</Empty>}
    </div>
  );
}
