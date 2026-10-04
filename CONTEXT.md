# openGym

A personal gym and body-weight tracker used from one phone. This fork is run for a single owner: one profile, signed in by passkey, installed on the phone's home screen.

## Language

**Profile**:
The one account on this instance: its name, passkeys, and everything it has logged. Data belongs to a profile, never to a device.
_Avoid_: User, account

**Passkey**:
The credential that signs the owner in, held by the phone's keychain and bound to the instance's hostname. The server only ever stores its public half.
_Avoid_: Password, login, key

**Setup code**:
A one-time secret that lets the first passkey be registered on a fresh instance. Removed once the owner has registered.
_Avoid_: Invite code (a different, multi-user feature that stays disabled here), admin token

**Re-enrolment**:
Replacing a lost passkey on the existing profile, using a new setup code, so no logged data is lost.
_Avoid_: Reset, recovery, new profile

**Active workout**:
A workout in progress. It lives on the device only and is never synced; once finished it becomes a logged workout.
_Avoid_: Session (also means a sign-in session)

**Rest alert**:
The notification that tells the owner a rest between sets is over while the app is in the background.
_Avoid_: Timer push, rest notification

**Daily reminder**:
The notification sent at the owner's chosen time on a day with a planned workout and none logged yet.
_Avoid_: Workout reminder, nag

**Home-screen install**:
The app added to the phone's home screen from Safari. It is the only form of the app on iPhone, and the only one that can receive push.
_Avoid_: Native app, APK
