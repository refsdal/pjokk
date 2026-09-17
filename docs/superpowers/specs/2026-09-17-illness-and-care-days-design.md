# Illness episodes, and the days at home with them

Issues #107 and #108, the fourth and fifth steps of the barnehage series.
The first barnehage year brings a run of infections. Pjokk logs
temperatures (with a fever flag) and medicine doses, but has no notion of
an illness: nothing ties Monday's fever to Tuesday's vomiting, nothing
answers "when can she go back?", and nobody knows in November that one
parent has used nine of their ten days at home and the other two.

Built autonomously at the owner's request on 2026-09-17; the decisions
below are recorded for him to overrule.

## The stance: a clock against the family's rule, never a verdict

The same stance as the medicine interval (#49). The app ships no medical
judgement and never says a child "may return". It shows a clock counting
from the last symptom, against a number of hours the family chose for
this episode, beside FHI's guidance quoted as cited reference text.

Reference: Folkehelseinstituttet, «Når må barnet være hjemme fra
barnehagen?» — two full days symptom-free after vomiting or diarrhoea;
home with a temperature above 38 °C; most other infections go by general
condition. https://www.fhi.no/sm/barnehage/nar-ma-barnet-vare-hjemme-fra-barne/

## #107 — the episode

```
illness(
  id, family_id, baby_id,
  caretaker_id, logged_by_id,        -- who noted it / who saved it
  start_time  timestamptz not null,
  end_time    timestamptz null,      -- NULL = still ill
  symptoms    text[] not null default '{}',
  last_symptom_at timestamptz null,  -- NULL = still having symptoms
  clear_hours integer null,          -- the family's rule for THIS episode
  notes       text null,
  created_at
)
unique (baby_id) where end_time is null
```

- **State, like a sleep session**: `activeIllness` on `/api/summary`, one
  open episode per baby by partial unique index.
- **Symptoms are chips**: fever, vomiting, diarrhoea, cough, cold, rash,
  eye, ear, other. A CHECK keeps the array inside that set.
- **`clear_hours` is the episode's own number.** The sheet prefills 48 when
  the symptoms include vomiting or diarrhoea and nothing otherwise, as
  chips (None / 24 h / 48 h / 72 h). On the episode rather than a family
  setting: a barnehage's own rule differs by illness, and a per-episode
  number needs no settings table.
- **The clock.** "Symptom-free since" is `last_symptom_at`. **Still has
  symptoms** clears it; **Symptom-free now** sets it. A fever reading
  logged after it moves it forward at READ time in the SPA (which already
  owns the 38.0 °C threshold and already loads three days of
  temperatures), so the server keeps no medical constant and the
  measurement factory gains no hook.
- `/api/illness`, shaped like `/api/daycare`: list, create, active,
  `POST /{id}/recover`, patch, delete. `tierFamily`; not for devices.
- **Home**: a calm card while an episode is open — "Ill since Mon ·
  vomiting · symptom-free since Tue 14:20 · 48 h on Thu 14:20", then
  "48 h symptom-free since Thu 14:20". Buttons: Still has symptoms /
  Symptom-free now, and Recovered. Started from More ("Illness").
- **Timeline**: kind `illness`, a span row under Other; sorted by start.
- CSV export rows; backup list; user-reference reassignment.

## #108 — days at home

Norwegian employees have a yearly quota of days at home with an ill child
(omsorgspenger, «sykt barn-dager»): 10 per calendar year with one or two
children, 15 with three or more, doubled for a sole carer; an employer can
ask for a doctor's note from the fourth consecutive day. Reference: NAV,
https://www.nav.no/omsorgspenger. The app states that as cited reference
text and computes nothing about entitlement: the quota is a number each
person sets.

```
care_day(
  id, family_id,
  user_id     text not null references users,     -- who stayed home
  baby_id     text null references baby on delete set null,
  illness_id  text null references illness on delete set null,
  date        date not null,                       -- the local calendar day
  fraction    double precision not null check (fraction in (0.5, 1)),
  note        text null,
  logged_by_id, created_at,
  unique (family_id, user_id, date)
)
care_day_quota(family_id, user_id, days integer, primary key (family_id, user_id))
```

- A day without an illness is allowed (the child-minder is ill, the
  barnehage sent her home).
- `date` is a calendar date, sent by the client as `YYYY-MM-DD` in the
  person's own day. No timezone arithmetic on the server.
- `/api/care-days?year=`: the rows plus per-member totals and quotas;
  create, patch, delete; `PUT /api/care-days/quota` for one's own or, as
  admin, anyone's.
- **Where it shows.** The illness card gains **Who is home today?** with
  the member chips and Half / Full. Settings → Family gains **Days at
  home**: this year per caretaker against their quota, the list, add and
  remove. A quiet line on the fourth consecutive day: "Day 4 in a row: an
  employer may ask for a doctor's note."
- Removing a member deletes their rows with their other personal data;
  deleting an account cascades (they are about the person's own leave).
- CSV export: its own section after the log rows.
