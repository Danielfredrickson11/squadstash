import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Redirect, Tabs, usePathname, useRouter } from "expo-router";
import React from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { useTheme } from "react-native-paper";

import { useClientOnlyValue } from "@/components/useClientOnlyValue";
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

  const headerShown = useClientOnlyValue(false, true);

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
      screenOptions={{
        headerShown,

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
        // way (isFocused() is false there).
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            if (navigation.isFocused() && isOnBucketDetail) {
              e.preventDefault();
              router.replace("/(tabs)/buckets");
            }
          },
        })}
      />

      {/* Hide the nested Bucket detail route from the tab bar */}
      <Tabs.Screen name="buckets/[bucketId]" options={{ href: null }} />

      <Tabs.Screen
        name="trips"
        options={{
          title: "Trips",
          tabBarIcon: ({ color }) => (
            <TabBarIcon name="suitcase" color={color} />
          ),
        }}
      />

      {/* Hide nested Trips routes from tab bar */}
      <Tabs.Screen name="trips/create" options={{ href: null }} />
      <Tabs.Screen name="trips/[tripId]" options={{ href: null }} />

      <Tabs.Screen
        name="transactions"
        options={{
          title: "Transactions",
          tabBarIcon: ({ color }) => <TabBarIcon name="list" color={color} />,
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
