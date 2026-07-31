/* LEXDEN NOVA — Cloud Function
   Watches the "feedNotify" collection (written by the admin panel only
   when a NEW feed post is marked "Important") and pushes a notification
   to every device stored in "fcmTokens". This is the one piece of the
   notification feature that genuinely can't run on a phone/browser alone
   — a client can't message OTHER clients directly, so a small always-on
   server-side function is required.

   ---- ONE-TIME SETUP (you'll need to do this yourself; I can't reach
   your Firebase project from here) ----
   1. Install the Firebase CLI if you don't have it:
        npm install -g firebase-tools
   2. From your project folder (the one containing this functions/ folder):
        firebase login
        firebase init functions   (choose your existing "lexden-nova" project,
                                    JavaScript, and say NO to overwriting
                                    this file if it asks)
   3. Cloud Functions requires the Blaze (pay-as-you-go) plan — the free
      tier of that plan covers this kind of light usage; it will not
      charge anything unless you go far beyond typical marketplace-app
      traffic.
   4. Deploy:
        firebase deploy --only functions
   That's it — from then on, marking a feed post "Important" in the admin
   panel will automatically notify every device that tapped "Enable
   Notifications" in the app's Menu screen. */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

exports.notifyImportantFeedPost = onDocumentCreated('feedNotify/{postId}', async (event) => {
  const data = event.data.data();
  if (!data) return;

  const tokensSnap = await db.collection('fcmTokens').get();
  const tokens = tokensSnap.docs.map((d) => d.id);
  if (!tokens.length) return;

  const message = {
    notification: {
      title: data.title || 'LEXDEN NOVA',
      body: data.body || 'Check out the latest update.',
      ...(data.coverUrl ? { image: data.coverUrl } : {}),
    },
    data: { postId: String(data.postId || event.params.postId) },
    tokens,
  };

  const res = await getMessaging().sendEachForMulticast(message);

  // Clean up tokens that are no longer valid (app uninstalled, permission
  // revoked, etc.) so the token list doesn't grow stale forever.
  const stale = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
        stale.push(tokens[i]);
      }
    }
  });
  await Promise.all(stale.map((t) => db.collection('fcmTokens').doc(t).delete().catch(() => {})));
});
