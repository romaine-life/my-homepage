import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as MicrosoftStrategy } from 'passport-microsoft';
import { Strategy as Auth0Strategy } from 'passport-auth0';

/**
 * Configures passport strategies for GitHub, Google, Microsoft (direct OAuth)
 * and Apple (via Auth0). All strategies normalise the user profile into the
 * same shape: { id, email, name, picture }.
 *
 * User IDs mirror Auth0's convention so existing Cosmos DB documents stay valid:
 *   github|{id}  ·  google-oauth2|{id}  ·  windowslive|{id}  ·  apple|{id}
 */
export function configurePassport(config) {
  // ── GitHub ──────────────────────────────────────────────────────
  passport.use('github', new GitHubStrategy(
    {
      clientID: config.githubClientId,
      clientSecret: config.githubClientSecret,
      callbackURL: '/placeholder', // overridden per-request in routes.js
      scope: ['user:email'],
    },
    (_accessToken, _refreshToken, profile, done) => {
      done(null, normaliseGitHub(profile));
    },
  ));

  // ── Google ──────────────────────────────────────────────────────
  passport.use('google', new GoogleStrategy(
    {
      clientID: config.googleClientId,
      clientSecret: config.googleClientSecret,
      callbackURL: '/placeholder',
      scope: ['openid', 'email', 'profile'],
    },
    (_accessToken, _refreshToken, profile, done) => {
      done(null, normaliseGoogle(profile));
    },
  ));

  // ── Microsoft ───────────────────────────────────────────────────
  passport.use('microsoft', new MicrosoftStrategy(
    {
      clientID: config.microsoftClientId,
      clientSecret: config.microsoftClientSecret,
      callbackURL: '/placeholder',
      scope: ['openid', 'profile', 'email'],
    },
    (_accessToken, _refreshToken, profile, done) => {
      done(null, normaliseMicrosoft(profile));
    },
  ));

  // ── Apple (via Auth0) ──────────────────────────────────────────
  passport.use('apple', new Auth0Strategy(
    {
      domain: config.auth0Domain,
      clientID: config.auth0AppleClientId,
      clientSecret: config.auth0AppleClientSecret,
      callbackURL: '/placeholder',
      state: false,
    },
    (_accessToken, _refreshToken, _extraParams, profile, done) => {
      done(null, normaliseAuth0(profile));
    },
  ));

}

// ── Profile normalisers ───────────────────────────────────────────

function normaliseGitHub(profile) {
  const email = profile.emails?.[0]?.value || '';
  return {
    id: `github|${profile.id}`,
    email,
    name: profile.displayName || profile.username || '',
    picture: profile.photos?.[0]?.value || '',
  };
}

function normaliseGoogle(profile) {
  return {
    id: `google-oauth2|${profile.id}`,
    email: profile.emails?.[0]?.value || '',
    name: profile.displayName || '',
    picture: profile.photos?.[0]?.value || '',
  };
}

function normaliseMicrosoft(profile) {
  return {
    id: `windowslive|${profile.id}`,
    email: profile.emails?.[0]?.value || '',
    name: profile.displayName || '',
    picture: '',
  };
}

function normaliseAuth0(profile) {
  return {
    id: profile.id || `apple|${profile.user_id || profile.sub || ''}`,
    email: profile.emails?.[0]?.value || profile._json?.email || '',
    name: profile.displayName || profile.nickname || '',
    picture: profile.picture || '',
  };
}


