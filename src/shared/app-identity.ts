export const OVERLOOK_TEAM_ID = 'Z5DM34QS5U';
export const OVERLOOK_PRODUCT_NAME = 'Overlook';
export const OVERLOOK_MAC_BUNDLE_ID = 'com.zts1.overlook';
export const OVERLOOK_MAC_APPLICATION_ID = `${OVERLOOK_TEAM_ID}.${OVERLOOK_MAC_BUNDLE_ID}`;
export const OVERLOOK_ICLOUD_CONTAINER_ID = `iCloud.${OVERLOOK_MAC_BUNDLE_ID}`;

export const OVERLOOK_LEGACY_MAC_BUNDLE_ID = 'com.qwts.overlook';

export const OVERLOOK_APP_LOCK_ANCHOR_SERVICE = `${OVERLOOK_MAC_BUNDLE_ID}.app-lock-anchor`;
export const OVERLOOK_APP_LOCK_ANCHOR_MIGRATION_SERVICE = `${OVERLOOK_MAC_BUNDLE_ID}.app-lock-anchor-migration`;
export const OVERLOOK_LEGACY_APP_LOCK_ANCHOR_SERVICE = `${OVERLOOK_LEGACY_MAC_BUNDLE_ID}.app-lock-anchor`;
// Native Messaging host identity is a cross-product wire contract and retains
// Image Trail's established name independently of the macOS bundle migration.
export const OVERLOOK_ICLOUD_NATIVE_HOST = 'com.qwts.overlook.interop';
