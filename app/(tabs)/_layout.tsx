import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Redirect, Tabs, usePathname, useRouter } from "expo-router";
import React from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { useTheme } from "react-native-paper";

import { BottomNav } from "../../components/navigation/BottomNav";
import { useAuth } from "../../src/contexts/AuthContext";

function TabBarIcon(props: {
  name: React.ComponentProps<typeof FontAwesome>["name"];
  color: string;
}) {
  return <FontAwesome size={24} style={{ marginBottom: -2 }} {...props} />;
}

export default function TabLayout() {
  const { user, loading } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  // usePathname() already strips route groups like "(tabs)" (Expo
  // Router's own normalization), so the Bucket list itself is exactly
  // "/buckets" and any nested detail route is "/buckets/<bucketId>" -
  // checked by prefix below so no bucketId is ever hardcoded.
  const pathname = usePathname();
  const isOnBucketDetail = pathname.startsWith("/buckets/");
  // Checkpoint 3F.3B.4C: same prefix-check pattern as Buckets above -
  // covers both nested Trips routes ("/trips/create" and
  // "/trips/<tripId>"), so re-tapping Trips from either one returns to
  // the Trips list, not just from a Trip Detail screen specifically.
  const isOnTripsNonRoot = pathname.startsWith("/trips/");

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Tabs
      // Checkpoint 3F.2: fully custom dark floating bar with a center
      // create action, replacing the default tabBarStyle-only rendering
      // below (that styling is now unused for the bar chrome itself but
      // left in place - headerShown/sceneStyle/headerStyle etc. below
      // still apply). See components/navigation/BottomNav.tsx for why
      // its tab-press handling is written to keep the existing Buckets
      // tabPress listener working unchanged.
      tabBar={(props) => <BottomNav {...props} />}
      screenOptions={{
        // Checkpoint 3F.2A root cause: this is the OUTER Tabs
        // navigator's own header, entirely separate from either nested
        // Stack's own header (app/(tabs)/buckets/_layout.tsx and
        // app/(tabs)/trips/_layout.tsx already set headerShown:false on
        // THEIR OWN Stack, independently of this setting) - it was
        // previously resolving to `true` on web via useClientOnlyValue,
        // painting a generic "Home"/"Buckets"/"Trips" bar above every
        // screen's own custom in-content header. Every screen that needs
        // a way back already has one of its own regardless of this
        // value (Bucket Detail's Back button, Trip Detail's "← Back",
        // Trip Create's Cancel button) - the tab bar itself is also
        // always available - so hiding this outer header everywhere is
        // safe and doesn't remove any actual navigation affordance.
        headerShown: false,

        // ✅ One consistent app background
        sceneStyle: { backgroundColor: theme.colors.background },

        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.onBackground,
        headerTitleStyle: { fontWeight: "900" },

        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.outline,
          borderTopWidth: 1,
          height: 62,
          paddingBottom: 6,
          paddingTop: 6,

          // subtle elevation
          ...Platform.select({
            android: { elevation: 8 },
            ios: {
              shadowOpacity: 0.08,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: -2 },
            },
            default: {},
          }),
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "700" },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
        }}
      />

      <Tabs.Screen
        name="buckets"
        options={{
          title: "Buckets",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="pie-chart" color={color} />
          ),
          // Checkpoint 3F.3B.4C audit: the tabPress listener below only
          // resets Buckets' nested stack when Buckets is already the
          // focused tab (a bare tab SWITCH away to Home/Trips and back
          // never fires tabPress, so a stale Bucket Detail screen was
          // still being revived on return - the same product bug as
          // Trips, just not previously named). popToTopOnBlur is
          // @react-navigation/bottom-tabs' own built-in mechanism for
          // exactly this: it pops the nested stack to its root the
          // moment this tab loses focus, so by the time the user comes
          // back to Buckets (by any route), the list is already showing.
          popToTopOnBlur: true,
        }}
        // Checkpoint 3C navigation review fix, scoped to Buckets only:
        // the nested buckets/_layout.tsx Stack can leave a Bucket detail
        // screen on top of its own history, and a bare tab press doesn't
        // reliably reset that nested stack on every platform/Expo Router
        // version. Only intercept when Buckets is already the focused
        // tab AND the current route is a nested detail route
        // ("/buckets/<bucketId>") - already being on the Bucket list
        // itself ("/buckets") must keep completely normal tab behavior,
        // and pressing the tab from a DIFFERENT tab is unaffected either
        // way (isFocused() is false there). Kept alongside
        // popToTopOnBlur above rather than replaced by it - blur-based
        // reset never fires for a tabPress on an ALREADY-focused tab
        // (nothing blurs), so this listener is still the only thing
        // that handles that specific case.
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            if (navigation.isFocused() && isOnBucketDetail) {
              e.preventDefault();
              router.replace("/(tabs)/buckets");
            }
          },
        })}
      />

      <Tabs.Screen
        name="trips"
        options={{
          title: "Trips",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="suitcase" color={color} />
          ),
          // Checkpoint 3F.3B.4C: Trip Detail -> Home -> Trips must land
          // on the Trips list, not revive the stale Trip Detail screen -
          // see the matching Buckets popToTopOnBlur comment above for
          // why this specific option is the correct fix (resets the
          // nested trips/_layout.tsx Stack to its root the moment this
          // tab blurs, rather than on the next tabPress).
          popToTopOnBlur: true,
        }}
        // Mirrors the Buckets tabPress listener above (same product
        // rule, same reasoning): re-tapping the Trips icon while Trips
        // is already the focused tab, from either nested non-root route
        // ("/trips/create" or "/trips/<tripId>"), returns to the Trips
        // list instead of leaving the stale screen on top. Nothing else
        // about Trips navigation changes.
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            if (navigation.isFocused() && isOnTripsNonRoot) {
              e.preventDefault();
              router.replace("/(tabs)/trips");
            }
          },
        })}
      />

      {/* Milestone 3 Checkpoint 3E: the Transactions surface is an
          unfinished placeholder (see app/(tabs)/transactions.tsx) - hidden
          from primary navigation rather than deleted, so the route and its
          architecture remain available for a future real implementation. */}
      <Tabs.Screen
        name="transactions"
        options={{
          title: "Transactions",
          tabBarIcon: ({ color }) => <TabBarIcon name="list" color={color} />,
          href: null,
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color }) => <TabBarIcon name="user" color={color} />,
        }}
      />
    </Tabs>
  );
}
