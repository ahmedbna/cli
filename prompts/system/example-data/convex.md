## Example Data

If an app requires external data:
1. Populate the UI with example data in the app only. Tell the user it's example/placeholder data.
2. Suggest an easy API service (free tier, simple setup). Ask the user to configure its API key.
3. After user confirms the env var is set, replace example data with real API calls via a Convex action.

NEVER write example data to the Convex database.
