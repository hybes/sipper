# Sipper build entry points.
#
#   make pjsip                 build PJSIP and Opus into vendor/ (once, ~3 minutes)
#   make project               generate Sipper.xcodeproj with XcodeGen
#   make app                   release build into dist/Sipper.app (ad-hoc signed)
#   make app TEAM=ABCDE12345   sign with your Apple Development identity (no Keychain prompts on rebuilds)
#   make app TEAM=… ICLOUD=1   also enable the iCloud container entitlement (needs the container in your team)
#   make release TEAM=… NOTARY_PROFILE=…
#                              Developer ID signed, notarised DMG in dist/ for publishing (README › Releasing)
#   make cask [VERSION=…]      point the Homebrew cask in hybes/homebrew-tap at the published release
#   make run                   build and launch the app
#   make test                  run the unit tests
#   make extension             package the Chrome extension into extension/dist
#   make icon                  regenerate the app icon PNGs
#   make site                  run the sipper.dev website locally (website/, Cloudflare Workers)
#   make site-deploy           deploy the website to Cloudflare
#   make clean                 remove build products (keeps vendor/pjsip)
#
# Find your Team ID with:  security find-identity -v -p codesigning   (the value in brackets is
# the certificate name; the Team ID is shown as OU in `security find-certificate -c "<name>" -p | openssl x509 -noout -subject`).

SCHEME       := Sipper
PROJECT      := Sipper.xcodeproj
DERIVED      := build/DerivedData
DIST         := dist
APP          := $(DIST)/Sipper.app
TEAM         ?=
ICLOUD       ?=
NOTARY_PROFILE ?=
SIGN_IDENTITY  ?=

ifneq ($(TEAM),)
ifneq ($(ICLOUD),)
# Restricted entitlements need a provisioning profile; let Xcode manage it (needs the Apple ID in Xcode).
SIGN_FLAGS   := CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=$(TEAM) CODE_SIGN_IDENTITY="Apple Development" \
                CODE_SIGN_ENTITLEMENTS=Sipper/Sipper-iCloud.entitlements SWIFT_ACTIVE_COMPILATION_CONDITIONS='$$(inherited) SIPPER_ICLOUD' -allowProvisioningUpdates
else
# A development certificate alone gives a stable signature; no profile is needed without restricted entitlements.
SIGN_FLAGS   := CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=$(TEAM) CODE_SIGN_IDENTITY="Apple Development" PROVISIONING_PROFILE_SPECIFIER=
endif
else
SIGN_FLAGS   := CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO
endif

XCODEBUILD   := xcodebuild -project $(PROJECT) -scheme $(SCHEME) -derivedDataPath $(DERIVED) $(SIGN_FLAGS)

.PHONY: all pjsip project app run release cask test extension icon clean

all: app

vendor/pjsip/lib/libpjproject.a:
	scripts/build-pjsip.sh

pjsip: vendor/pjsip/lib/libpjproject.a

$(PROJECT): project.yml
	xcodegen generate --quiet

project:
	xcodegen generate --quiet

app: pjsip $(PROJECT)
	set -o pipefail; $(XCODEBUILD) -configuration Release build | tools/xcpretty-lite.sh
	rm -rf "$(APP)" && mkdir -p "$(DIST)"
	cp -R "$(DERIVED)/Build/Products/Release/Sipper.app" "$(APP)"
ifeq ($(TEAM),)
	codesign --force --deep --sign - --entitlements Sipper/Sipper.entitlements --options runtime "$(APP)"
	@echo "Built $(APP) (ad-hoc signed; expect a Keychain prompt after each rebuild — use make app TEAM=<TeamID> to avoid it)"
else
	@echo "Built $(APP) (signed with team $(TEAM))"
endif

run: app
	open "$(APP)"

release: pjsip $(PROJECT)
	TEAM="$(TEAM)" NOTARY_PROFILE="$(NOTARY_PROFILE)" SIGN_IDENTITY="$(SIGN_IDENTITY)" tools/release.sh

cask:
	VERSION="$(VERSION)" tools/update-cask.sh

test: pjsip $(PROJECT)
	set -o pipefail; $(XCODEBUILD) -configuration Debug test | tools/xcpretty-lite.sh

extension:
	tools/package-extension.sh

icon:
	swift tools/make-icon.swift Sipper/Resources/Assets.xcassets/AppIcon.appiconset

clean:
	rm -rf build $(DIST) $(PROJECT)

# sipper.dev website (website/, Cloudflare Workers static assets)
.PHONY: site site-deploy

website/node_modules: website/package.json
	npm --prefix website install --no-audit --no-fund
	@touch $@

site: website/node_modules
	npm --prefix website run dev

site-deploy: website/node_modules
	npm --prefix website run deploy
