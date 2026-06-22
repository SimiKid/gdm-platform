workspace "GDM Study Platform" "AI-supported group decision-making study" {

    model {
        participant = person "Participant" "Member of a 5-person hiring committee"
        researcher  = person "Researcher" "Configures conditions, exports data"

        gdm = softwareSystem "GDM Study Platform" "Runs AI-assisted group decision-making sessions" {

            spa = container "Participant client" "WhatsApp-style chat UI; lobby, briefing, poll, exit survey; renders inline private nudges" "React, matrix-js-sdk"
            admin = container "Researcher dashboard" "Conditions, session pool, completion counts, export" "React"
            control = container "Control plane / app server" "Lobby & condition assignment, user provisioning, surveys, polls, export" "NestJS"
            synapse = container "Synapse homeserver" "Real-time messaging; rooms = groups; encryption disabled so the bot can read" "Matrix / Synapse"

            engine = container "Rule engine" "Detects non-acknowledged contributions; sends group or private nudges" "Node appservice" {
                ingest = component "Event adapter" "Receives m.room.message / m.reaction from the appservice stream" "matrix-bot-sdk"
                state = component "State tracker" "Per-room contribution state: reply graph, timers, reaction set" "TypeScript"
                detectors = component "Detectors" "Non-acknowledgment rules: reply window, reactions, silence" "TypeScript"
                ruleset = component "Ruleset config" "Configurable thresholds per condition" "JSON/YAML"
                gate = component "Condition gate" "Maps a fired rule to group / private / no nudge for the 2x2 cell" "TypeScript"
                dispatch = component "Dispatcher" "Emits the nudge as a Matrix room message or bot-to-user DM" "TypeScript"
                logger = component "Logger" "Persists interventions & behavioural events" "TypeScript"
            }

            etherpad = container "Etherpad" "Shared notepad, embedded via iframe" "Etherpad"

            researchdb = container "Research database" "Messages, interventions, behavioural events; source for JSON/CSV export" "PostgreSQL" {
                tags "Database"
            }
            synapsedb = container "Synapse database" "Matrix event graph & state (internal to Synapse)" "PostgreSQL" {
                tags "Database"
            }
        }

        # container-level relationships
        participant -> spa "Uses" "HTTPS"
        researcher -> admin "Uses" "HTTPS"

        spa -> control "Experiment flow: briefing, surveys, polls, provisioning" "HTTPS/JSON"
        spa -> synapse "Sends/receives messages, reactions, typing" "Matrix Client-Server API"
        spa -> etherpad "Collaborative notes" "HTTPS (iframe)"
        admin -> control "Manage conditions, trigger export" "HTTPS/JSON"

        control -> synapse "Provisions virtual users & rooms" "Appservice login / Admin API"
        control -> researchdb "Reads/writes experiment data" "SQL"
        synapse -> synapsedb "Reads/writes" "SQL"

        # component-level relationships (container/system links are implied automatically)
        synapse -> ingest "Event stream" "Appservice API"
        ingest -> state "Normalized message / reaction events"
        state -> detectors "Current room state"
        ruleset -> detectors "Thresholds"
        detectors -> gate "Fired non-ack signals"
        control -> gate "Session condition" "config"
        gate -> dispatch "Nudge action (group / private)"
        dispatch -> synapse "Post nudge" "Client-Server API"
        gate -> logger "Intervention record"
        state -> logger "Behavioural events"
        logger -> researchdb "Writes" "SQL"
    }

    views {
        systemContext gdm "Context" {
            include *
            autolayout lr
        }

        container gdm "Containers" {
            include *
            autolayout lr
        }

        component engine "RuleEngine" {
            include *
            autolayout lr
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            element "Database" {
                shape cylinder
            }
        }
    }
}
