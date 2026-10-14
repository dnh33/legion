declare const CATEGORIES: readonly [{
    readonly id: "input";
    readonly label: "Input";
    readonly description: "Pointer, key, and touch contact.";
}, {
    readonly id: "selection";
    readonly label: "Selection";
    readonly description: "Choosing, switching, and changing state.";
}, {
    readonly id: "navigation";
    readonly label: "Navigation";
    readonly description: "Moving through views and layers.";
}, {
    readonly id: "editing";
    readonly label: "Editing";
    readonly description: "Changing work with reversible and destructive actions.";
}, {
    readonly id: "movement";
    readonly label: "Movement";
    readonly description: "Dragging, snapping, and spatial gestures.";
}, {
    readonly id: "communication";
    readonly label: "Communication";
    readonly description: "Messages and attention.";
}, {
    readonly id: "feedback";
    readonly label: "Feedback";
    readonly description: "Clear outcomes and system status.";
}, {
    readonly id: "progress";
    readonly label: "Progress";
    readonly description: "Processes from start to finish.";
}, {
    readonly id: "loops";
    readonly label: "Loops";
    readonly description: "Continuous state while work, capture, or connection is active.";
}, {
    readonly id: "media";
    readonly label: "Media";
    readonly description: "Playback, seeking, and listening controls.";
}, {
    readonly id: "system";
    readonly label: "System";
    readonly description: "Connections, access, and device state.";
}, {
    readonly id: "reward";
    readonly label: "Reward";
    readonly description: "Milestones, value, and celebration.";
}, {
    readonly id: "commerce";
    readonly label: "Commerce";
    readonly description: "Cart, checkout, and value exchange.";
}];
type CategoryName = (typeof CATEGORIES)[number]['id'];
interface PatternNote {
    at: number;
    semitone: number;
    length: number;
    glide?: number;
    gain?: number;
}
interface CueDefinition {
    name: string;
    label: string;
    category: CategoryName;
    description: string;
    duration: number;
    baseMidi: number;
    notes: readonly PatternNote[];
    noise?: number;
    transient?: number;
    panFrom?: number;
    panTo?: number;
    loop?: boolean;
    defaultVolume: number;
}
declare const CUES: readonly [{
    readonly name: "hover";
    readonly label: "Hover";
    readonly category: "input";
    readonly description: "Fine-pointer discovery without commitment.";
    readonly duration: 0.12;
    readonly baseMidi: 78;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.09;
    }];
    readonly noise: 0.04;
    readonly defaultVolume: 0.12;
}, {
    readonly name: "press";
    readonly label: "Press";
    readonly category: "input";
    readonly description: "A control is physically engaged.";
    readonly duration: 0.16;
    readonly baseMidi: 62;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 3;
        readonly length: 0.13;
        readonly glide: -4;
    }];
    readonly noise: 0.14;
    readonly transient: 0.5;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "release";
    readonly label: "Release";
    readonly category: "input";
    readonly description: "A pressed control springs back.";
    readonly duration: 0.18;
    readonly baseMidi: 68;
    readonly notes: readonly [{
        readonly at: 0.01;
        readonly semitone: -2;
        readonly length: 0.14;
        readonly glide: 4;
    }];
    readonly noise: 0.06;
    readonly transient: 0.3;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "double-click";
    readonly label: "Double click";
    readonly category: "input";
    readonly description: "A rapid secondary activation.";
    readonly duration: 0.24;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.07;
    }, {
        readonly at: 0.105;
        readonly semitone: 2;
        readonly length: 0.08;
    }];
    readonly transient: 0.5;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "focus";
    readonly label: "Focus";
    readonly category: "input";
    readonly description: "A control becomes ready for keyboard or text input.";
    readonly duration: 0.23;
    readonly baseMidi: 74;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.17;
        readonly glide: 1;
    }, {
        readonly at: 0;
        readonly semitone: 2;
        readonly length: 0.17;
        readonly gain: 0.26;
    }];
    readonly noise: 0.015;
    readonly defaultVolume: 0.12;
}, {
    readonly name: "long-press";
    readonly label: "Long press";
    readonly category: "input";
    readonly description: "A sustained press reveals a secondary action.";
    readonly duration: 0.46;
    readonly baseMidi: 58;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.34;
        readonly glide: 5;
    }, {
        readonly at: 0.28;
        readonly semitone: 7;
        readonly length: 0.13;
        readonly gain: 0.5;
    }];
    readonly noise: 0.08;
    readonly transient: 0.32;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "select";
    readonly label: "Select";
    readonly category: "selection";
    readonly description: "An item enters the active set.";
    readonly duration: 0.28;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.12;
    }, {
        readonly at: 0.09;
        readonly semitone: 7;
        readonly length: 0.16;
    }];
    readonly defaultVolume: 0.2;
}, {
    readonly name: "deselect";
    readonly label: "Deselect";
    readonly category: "selection";
    readonly description: "An item leaves the active set.";
    readonly duration: 0.25;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 4;
        readonly length: 0.09;
    }, {
        readonly at: 0.075;
        readonly semitone: -2;
        readonly length: 0.15;
    }];
    readonly defaultVolume: 0.17;
}, {
    readonly name: "toggle-on";
    readonly label: "Toggle on";
    readonly category: "selection";
    readonly description: "A binary setting becomes active.";
    readonly duration: 0.3;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -3;
        readonly length: 0.065;
        readonly glide: -1;
    }, {
        readonly at: 0.065;
        readonly semitone: 9;
        readonly length: 0.2;
    }];
    readonly transient: 0.3;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "toggle-off";
    readonly label: "Toggle off";
    readonly category: "selection";
    readonly description: "A binary setting becomes inactive.";
    readonly duration: 0.29;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 9;
        readonly length: 0.065;
    }, {
        readonly at: 0.07;
        readonly semitone: -3;
        readonly length: 0.18;
        readonly glide: -1;
    }];
    readonly transient: 0.28;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "check";
    readonly label: "Check";
    readonly category: "selection";
    readonly description: "A checkbox or task enters its completed state.";
    readonly duration: 0.29;
    readonly baseMidi: 71;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.075;
    }, {
        readonly at: 0.07;
        readonly semitone: 9;
        readonly length: 0.17;
    }];
    readonly transient: 0.24;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "uncheck";
    readonly label: "Uncheck";
    readonly category: "selection";
    readonly description: "A checkbox or task returns to its incomplete state.";
    readonly duration: 0.27;
    readonly baseMidi: 71;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 9;
        readonly length: 0.07;
    }, {
        readonly at: 0.065;
        readonly semitone: -5;
        readonly length: 0.15;
    }];
    readonly transient: 0.22;
    readonly defaultVolume: 0.15;
}, {
    readonly name: "delete";
    readonly label: "Delete";
    readonly category: "editing";
    readonly description: "A destructive removal is committed.";
    readonly duration: 0.48;
    readonly baseMidi: 58;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 6;
        readonly length: 0.2;
        readonly glide: -7;
    }, {
        readonly at: 0.16;
        readonly semitone: -2;
        readonly length: 0.24;
        readonly gain: 0.6;
    }];
    readonly noise: 0.18;
    readonly transient: 0.5;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "cancel";
    readonly label: "Cancel";
    readonly category: "editing";
    readonly description: "A pending action is abandoned without applying.";
    readonly duration: 0.34;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 3;
        readonly length: 0.11;
    }, {
        readonly at: 0.08;
        readonly semitone: -3;
        readonly length: 0.2;
        readonly glide: -2;
    }];
    readonly noise: 0.05;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "undo";
    readonly label: "Undo";
    readonly category: "editing";
    readonly description: "The most recent change is reversed.";
    readonly duration: 0.44;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 9;
        readonly length: 0.16;
        readonly glide: -3;
    }, {
        readonly at: 0.15;
        readonly semitone: 4;
        readonly length: 0.14;
    }, {
        readonly at: 0.27;
        readonly semitone: -2;
        readonly length: 0.13;
        readonly gain: 0.62;
    }];
    readonly panFrom: 0.45;
    readonly panTo: -0.45;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "redo";
    readonly label: "Redo";
    readonly category: "editing";
    readonly description: "A reversed change is applied again.";
    readonly duration: 0.44;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.13;
        readonly gain: 0.62;
    }, {
        readonly at: 0.12;
        readonly semitone: 4;
        readonly length: 0.14;
    }, {
        readonly at: 0.25;
        readonly semitone: 9;
        readonly length: 0.16;
        readonly glide: 2;
    }];
    readonly panFrom: -0.45;
    readonly panTo: 0.45;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "copy";
    readonly label: "Copy";
    readonly category: "editing";
    readonly description: "Selected content is placed on the clipboard.";
    readonly duration: 0.3;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.14;
    }, {
        readonly at: 0.1;
        readonly semitone: 12;
        readonly length: 0.15;
        readonly gain: 0.48;
    }];
    readonly panFrom: -0.2;
    readonly panTo: 0.2;
    readonly defaultVolume: 0.15;
}, {
    readonly name: "paste";
    readonly label: "Paste";
    readonly category: "editing";
    readonly description: "Clipboard content is inserted into the current context.";
    readonly duration: 0.36;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 12;
        readonly length: 0.08;
        readonly gain: 0.3;
    }, {
        readonly at: 0.065;
        readonly semitone: 0;
        readonly length: 0.19;
    }, {
        readonly at: 0.17;
        readonly semitone: 3;
        readonly length: 0.14;
        readonly gain: 0.42;
    }];
    readonly transient: 0.22;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "open";
    readonly label: "Open";
    readonly category: "navigation";
    readonly description: "A menu, sheet, panel, or detail view appears.";
    readonly duration: 0.37;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.28;
        readonly glide: 9;
    }, {
        readonly at: 0.18;
        readonly semitone: 12;
        readonly length: 0.11;
        readonly gain: 0.3;
    }];
    readonly noise: 0.05;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "close";
    readonly label: "Close";
    readonly category: "navigation";
    readonly description: "A menu, sheet, panel, or detail view recedes.";
    readonly duration: 0.34;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 12;
        readonly length: 0.1;
        readonly gain: 0.34;
    }, {
        readonly at: 0.055;
        readonly semitone: 5;
        readonly length: 0.24;
        readonly glide: -8;
    }];
    readonly noise: 0.04;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "back";
    readonly label: "Back";
    readonly category: "navigation";
    readonly description: "Navigation returns to the previous place.";
    readonly duration: 0.3;
    readonly baseMidi: 66;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 3;
        readonly length: 0.23;
        readonly glide: -5;
    }];
    readonly noise: 0.08;
    readonly panFrom: 0.35;
    readonly panTo: -0.55;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "forward";
    readonly label: "Forward";
    readonly category: "navigation";
    readonly description: "Navigation advances to the next place.";
    readonly duration: 0.31;
    readonly baseMidi: 66;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.12;
        readonly glide: 3;
        readonly gain: 0.55;
    }, {
        readonly at: 0.09;
        readonly semitone: 4;
        readonly length: 0.17;
    }];
    readonly noise: 0.06;
    readonly panFrom: -0.35;
    readonly panTo: 0.55;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "expand";
    readonly label: "Expand";
    readonly category: "navigation";
    readonly description: "A collapsed region reveals more detail.";
    readonly duration: 0.37;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.12;
    }, {
        readonly at: 0.11;
        readonly semitone: 4;
        readonly length: 0.13;
    }, {
        readonly at: 0.22;
        readonly semitone: 9;
        readonly length: 0.12;
        readonly gain: 0.52;
    }];
    readonly panFrom: 0;
    readonly panTo: 0.35;
    readonly defaultVolume: 0.16;
}, {
    readonly name: "collapse";
    readonly label: "Collapse";
    readonly category: "navigation";
    readonly description: "An expanded region returns to its compact state.";
    readonly duration: 0.35;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 9;
        readonly length: 0.11;
        readonly gain: 0.52;
    }, {
        readonly at: 0.1;
        readonly semitone: 4;
        readonly length: 0.12;
    }, {
        readonly at: 0.2;
        readonly semitone: 0;
        readonly length: 0.12;
    }];
    readonly panFrom: 0.35;
    readonly panTo: 0;
    readonly defaultVolume: 0.15;
}, {
    readonly name: "drag-start";
    readonly label: "Drag start";
    readonly category: "movement";
    readonly description: "An object lifts from its resting place.";
    readonly duration: 0.28;
    readonly baseMidi: 57;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.22;
        readonly glide: 6;
    }];
    readonly noise: 0.14;
    readonly transient: 0.3;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "drop";
    readonly label: "Drop";
    readonly category: "movement";
    readonly description: "A dragged object lands in a valid target.";
    readonly duration: 0.3;
    readonly baseMidi: 55;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 7;
        readonly length: 0.1;
        readonly gain: 0.4;
    }, {
        readonly at: 0.045;
        readonly semitone: 0;
        readonly length: 0.17;
        readonly glide: -5;
    }, {
        readonly at: 0.12;
        readonly semitone: -5;
        readonly length: 0.13;
        readonly gain: 0.38;
    }];
    readonly noise: 0.18;
    readonly transient: 0.6;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "snap";
    readonly label: "Snap";
    readonly category: "movement";
    readonly description: "An object locks into a precise position.";
    readonly duration: 0.16;
    readonly baseMidi: 73;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.1;
    }, {
        readonly at: 0.045;
        readonly semitone: 12;
        readonly length: 0.08;
        readonly gain: 0.45;
    }];
    readonly transient: 0.75;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "swipe";
    readonly label: "Swipe";
    readonly category: "movement";
    readonly description: "A touch gesture moves content spatially.";
    readonly duration: 0.38;
    readonly baseMidi: 69;
    readonly notes: readonly [{
        readonly at: 0.02;
        readonly semitone: -4;
        readonly length: 0.29;
        readonly glide: 8;
        readonly gain: 0.28;
    }];
    readonly noise: 0.38;
    readonly transient: 0.08;
    readonly panFrom: -0.7;
    readonly panTo: 0.7;
    readonly defaultVolume: 0.14;
}, {
    readonly name: "reorder";
    readonly label: "Reorder";
    readonly category: "movement";
    readonly description: "An item settles into a new position in a sequence.";
    readonly duration: 0.34;
    readonly baseMidi: 61;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 7;
        readonly length: 0.1;
        readonly glide: -2;
    }, {
        readonly at: 0.085;
        readonly semitone: 2;
        readonly length: 0.1;
    }, {
        readonly at: 0.17;
        readonly semitone: 0;
        readonly length: 0.13;
    }];
    readonly noise: 0.08;
    readonly transient: 0.38;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "invalid-drop";
    readonly label: "Invalid drop";
    readonly category: "movement";
    readonly description: "A dragged object cannot land in the current target.";
    readonly duration: 0.4;
    readonly baseMidi: 59;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 1;
        readonly length: 0.11;
    }, {
        readonly at: 0.12;
        readonly semitone: -4;
        readonly length: 0.13;
    }, {
        readonly at: 0.24;
        readonly semitone: 1;
        readonly length: 0.11;
        readonly glide: -2;
        readonly gain: 0.65;
    }];
    readonly noise: 0.14;
    readonly transient: 0.3;
    readonly defaultVolume: 0.19;
}, {
    readonly name: "send";
    readonly label: "Send";
    readonly category: "communication";
    readonly description: "A message or object leaves the user.";
    readonly duration: 0.42;
    readonly baseMidi: 69;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.28;
        readonly glide: 9;
    }, {
        readonly at: 0.19;
        readonly semitone: 12;
        readonly length: 0.16;
        readonly gain: 0.6;
    }];
    readonly noise: 0.16;
    readonly panFrom: -0.2;
    readonly panTo: 0.5;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "receive";
    readonly label: "Receive";
    readonly category: "communication";
    readonly description: "A response or object arrives.";
    readonly duration: 0.47;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 12;
        readonly length: 0.12;
        readonly gain: 0.42;
    }, {
        readonly at: 0.11;
        readonly semitone: 4;
        readonly length: 0.2;
        readonly glide: -2;
    }, {
        readonly at: 0.25;
        readonly semitone: 0;
        readonly length: 0.17;
        readonly gain: 0.62;
    }];
    readonly noise: 0.06;
    readonly panFrom: 0.45;
    readonly panTo: 0;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "notification";
    readonly label: "Notification";
    readonly category: "communication";
    readonly description: "New information is available, without urgency.";
    readonly duration: 0.58;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.26;
    }, {
        readonly at: 0.19;
        readonly semitone: 5;
        readonly length: 0.3;
    }];
    readonly defaultVolume: 0.2;
}, {
    readonly name: "mention";
    readonly label: "Mention";
    readonly category: "communication";
    readonly description: "The user is directly addressed.";
    readonly duration: 0.64;
    readonly baseMidi: 74;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.18;
    }, {
        readonly at: 0.16;
        readonly semitone: 4;
        readonly length: 0.18;
    }, {
        readonly at: 0.32;
        readonly semitone: 9;
        readonly length: 0.25;
    }];
    readonly defaultVolume: 0.22;
}, {
    readonly name: "typing";
    readonly label: "Typing";
    readonly category: "communication";
    readonly description: "A brief key contact during text entry.";
    readonly duration: 0.045;
    readonly baseMidi: 73;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.024;
        readonly glide: -1;
    }];
    readonly noise: 0.025;
    readonly transient: 0.18;
    readonly defaultVolume: 0.065;
}, {
    readonly name: "reaction";
    readonly label: "Reaction";
    readonly category: "communication";
    readonly description: "A lightweight social response is added.";
    readonly duration: 0.4;
    readonly baseMidi: 75;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.1;
    }, {
        readonly at: 0.075;
        readonly semitone: 12;
        readonly length: 0.13;
        readonly gain: 0.62;
    }, {
        readonly at: 0.18;
        readonly semitone: 7;
        readonly length: 0.16;
    }];
    readonly transient: 0.16;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "success";
    readonly label: "Success";
    readonly category: "feedback";
    readonly description: "An action finished with the expected result.";
    readonly duration: 0.72;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.3;
    }, {
        readonly at: 0.16;
        readonly semitone: 4;
        readonly length: 0.32;
    }, {
        readonly at: 0.33;
        readonly semitone: 7;
        readonly length: 0.33;
    }];
    readonly defaultVolume: 0.23;
}, {
    readonly name: "error";
    readonly label: "Error";
    readonly category: "feedback";
    readonly description: "An action failed and needs attention.";
    readonly duration: 0.62;
    readonly baseMidi: 62;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 6;
        readonly length: 0.28;
    }, {
        readonly at: 0.22;
        readonly semitone: 0;
        readonly length: 0.32;
        readonly glide: -2;
    }];
    readonly noise: 0.1;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "warning";
    readonly label: "Warning";
    readonly category: "feedback";
    readonly description: "A risky or consequential state needs review.";
    readonly duration: 0.68;
    readonly baseMidi: 65;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.22;
    }, {
        readonly at: 0.28;
        readonly semitone: 0;
        readonly length: 0.3;
    }];
    readonly transient: 0.2;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "info";
    readonly label: "Info";
    readonly category: "feedback";
    readonly description: "A neutral system fact is surfaced.";
    readonly duration: 0.46;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.18;
    }, {
        readonly at: 0.2;
        readonly semitone: 5;
        readonly length: 0.18;
        readonly gain: 0.58;
    }];
    readonly defaultVolume: 0.16;
}, {
    readonly name: "blocked";
    readonly label: "Blocked";
    readonly category: "feedback";
    readonly description: "An action cannot continue in the current state.";
    readonly duration: 0.43;
    readonly baseMidi: 57;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.13;
    }, {
        readonly at: 0.14;
        readonly semitone: -5;
        readonly length: 0.2;
        readonly glide: -2;
    }];
    readonly noise: 0.12;
    readonly transient: 0.44;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "retry";
    readonly label: "Retry";
    readonly category: "feedback";
    readonly description: "A failed action is attempted again.";
    readonly duration: 0.42;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.17;
        readonly glide: 4;
    }, {
        readonly at: 0.16;
        readonly semitone: 5;
        readonly length: 0.21;
    }];
    readonly noise: 0.06;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "start";
    readonly label: "Start";
    readonly category: "progress";
    readonly description: "A process, recording, or session begins.";
    readonly duration: 0.46;
    readonly baseMidi: 60;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.12;
        readonly gain: 0.48;
    }, {
        readonly at: 0.1;
        readonly semitone: 0;
        readonly length: 0.18;
    }, {
        readonly at: 0.24;
        readonly semitone: 7;
        readonly length: 0.18;
    }];
    readonly noise: 0.04;
    readonly defaultVolume: 0.19;
}, {
    readonly name: "stop";
    readonly label: "Stop";
    readonly category: "progress";
    readonly description: "A process, recording, or session ends.";
    readonly duration: 0.4;
    readonly baseMidi: 60;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 7;
        readonly length: 0.11;
    }, {
        readonly at: 0.1;
        readonly semitone: 2;
        readonly length: 0.12;
    }, {
        readonly at: 0.2;
        readonly semitone: -5;
        readonly length: 0.15;
        readonly gain: 0.72;
    }];
    readonly noise: 0.06;
    readonly defaultVolume: 0.19;
}, {
    readonly name: "progress-step";
    readonly label: "Progress step";
    readonly category: "progress";
    readonly description: "A discrete step advances inside a longer process.";
    readonly duration: 0.23;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.07;
    }, {
        readonly at: 0.085;
        readonly semitone: 3;
        readonly length: 0.1;
        readonly gain: 0.64;
    }];
    readonly noise: 0.02;
    readonly defaultVolume: 0.12;
}, {
    readonly name: "complete";
    readonly label: "Complete";
    readonly category: "progress";
    readonly description: "A multi-step process reaches its final state.";
    readonly duration: 0.8;
    readonly baseMidi: 65;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.22;
    }, {
        readonly at: 0.22;
        readonly semitone: 7;
        readonly length: 0.25;
    }, {
        readonly at: 0.46;
        readonly semitone: 12;
        readonly length: 0.27;
    }];
    readonly defaultVolume: 0.24;
}, {
    readonly name: "queued";
    readonly label: "Queued";
    readonly category: "progress";
    readonly description: "Work is accepted and waiting to begin.";
    readonly duration: 0.36;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.14;
    }, {
        readonly at: 0.13;
        readonly semitone: 2;
        readonly length: 0.18;
        readonly gain: 0.65;
    }];
    readonly noise: 0.04;
    readonly defaultVolume: 0.14;
}, {
    readonly name: "checkpoint";
    readonly label: "Checkpoint";
    readonly category: "progress";
    readonly description: "A meaningful stage in a longer process is saved.";
    readonly duration: 0.5;
    readonly baseMidi: 69;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.18;
    }, {
        readonly at: 0.14;
        readonly semitone: 5;
        readonly length: 0.18;
    }, {
        readonly at: 0.28;
        readonly semitone: 9;
        readonly length: 0.17;
        readonly gain: 0.6;
    }];
    readonly defaultVolume: 0.18;
}, {
    readonly name: "loading";
    readonly label: "Loading";
    readonly category: "loops";
    readonly description: "A quiet repeating pulse while an interface fetches or waits.";
    readonly duration: 1.2;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.16;
    }, {
        readonly at: 0.3;
        readonly semitone: 5;
        readonly length: 0.16;
    }, {
        readonly at: 0.6;
        readonly semitone: 2;
        readonly length: 0.16;
    }, {
        readonly at: 0.9;
        readonly semitone: 7;
        readonly length: 0.16;
    }];
    readonly loop: true;
    readonly defaultVolume: 0.1;
}, {
    readonly name: "processing";
    readonly label: "Processing";
    readonly category: "loops";
    readonly description: "A restrained repeating bed while sustained work is running.";
    readonly duration: 1.6;
    readonly baseMidi: 62;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.24;
    }, {
        readonly at: 0.4;
        readonly semitone: 5;
        readonly length: 0.2;
        readonly gain: 0.7;
    }, {
        readonly at: 0.8;
        readonly semitone: 2;
        readonly length: 0.24;
    }, {
        readonly at: 1.2;
        readonly semitone: 7;
        readonly length: 0.2;
        readonly gain: 0.7;
    }];
    readonly loop: true;
    readonly noise: 0.05;
    readonly defaultVolume: 0.08;
}, {
    readonly name: "recording";
    readonly label: "Recording";
    readonly category: "loops";
    readonly description: "A calm periodic pulse while audio or video capture is live.";
    readonly duration: 1;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.2;
    }, {
        readonly at: 0.5;
        readonly semitone: 0;
        readonly length: 0.14;
        readonly gain: 0.45;
    }];
    readonly loop: true;
    readonly transient: 0.08;
    readonly defaultVolume: 0.09;
}, {
    readonly name: "connecting";
    readonly label: "Connecting";
    readonly category: "loops";
    readonly description: "A repeating search pattern while a device or live session connects.";
    readonly duration: 1.5;
    readonly baseMidi: 69;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.18;
    }, {
        readonly at: 0.375;
        readonly semitone: 4;
        readonly length: 0.18;
    }, {
        readonly at: 0.75;
        readonly semitone: 7;
        readonly length: 0.2;
    }, {
        readonly at: 1.125;
        readonly semitone: 4;
        readonly length: 0.16;
        readonly gain: 0.55;
    }];
    readonly loop: true;
    readonly panFrom: -0.3;
    readonly panTo: 0.3;
    readonly defaultVolume: 0.09;
}, {
    readonly name: "scanning";
    readonly label: "Scanning";
    readonly category: "loops";
    readonly description: "A spatial sweep repeats while content or devices are discovered.";
    readonly duration: 1.4;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.28;
        readonly glide: 8;
        readonly gain: 0.55;
    }, {
        readonly at: 0.7;
        readonly semitone: 3;
        readonly length: 0.28;
        readonly glide: -8;
        readonly gain: 0.45;
    }];
    readonly loop: true;
    readonly noise: 0.12;
    readonly panFrom: -0.65;
    readonly panTo: 0.65;
    readonly defaultVolume: 0.075;
}, {
    readonly name: "streaming";
    readonly label: "Streaming";
    readonly category: "loops";
    readonly description: "A quiet repeating flow while live data or media continues.";
    readonly duration: 1.2;
    readonly baseMidi: 65;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.2;
    }, {
        readonly at: 0.3;
        readonly semitone: 7;
        readonly length: 0.16;
        readonly gain: 0.5;
    }, {
        readonly at: 0.6;
        readonly semitone: 2;
        readonly length: 0.2;
    }, {
        readonly at: 0.9;
        readonly semitone: 9;
        readonly length: 0.16;
        readonly gain: 0.5;
    }];
    readonly loop: true;
    readonly noise: 0.08;
    readonly panFrom: -0.2;
    readonly panTo: 0.2;
    readonly defaultVolume: 0.07;
}, {
    readonly name: "play";
    readonly label: "Play";
    readonly category: "media";
    readonly description: "Media playback begins or resumes.";
    readonly duration: 0.34;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.09;
        readonly gain: 0.52;
    }, {
        readonly at: 0.075;
        readonly semitone: 0;
        readonly length: 0.11;
    }, {
        readonly at: 0.16;
        readonly semitone: 7;
        readonly length: 0.13;
        readonly gain: 0.72;
    }];
    readonly transient: 0.2;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "pause";
    readonly label: "Pause";
    readonly category: "media";
    readonly description: "Media playback pauses at the current position.";
    readonly duration: 0.32;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 4;
        readonly length: 0.11;
    }, {
        readonly at: 0.13;
        readonly semitone: 4;
        readonly length: 0.13;
    }];
    readonly transient: 0.25;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "seek";
    readonly label: "Seek";
    readonly category: "media";
    readonly description: "The playback position moves to a new point.";
    readonly duration: 0.3;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.105;
        readonly glide: 2;
        readonly gain: 0.55;
    }, {
        readonly at: 0.115;
        readonly semitone: 5;
        readonly length: 0.12;
        readonly glide: 2;
        readonly gain: 0.72;
    }];
    readonly noise: 0.15;
    readonly panFrom: -0.55;
    readonly panTo: 0.55;
    readonly defaultVolume: 0.13;
}, {
    readonly name: "volume-change";
    readonly label: "Volume change";
    readonly category: "media";
    readonly description: "Playback loudness moves to a new level.";
    readonly duration: 0.24;
    readonly baseMidi: 76;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -4;
        readonly length: 0.055;
        readonly gain: 0.45;
    }, {
        readonly at: 0.055;
        readonly semitone: 0;
        readonly length: 0.065;
        readonly gain: 0.62;
    }, {
        readonly at: 0.115;
        readonly semitone: 4;
        readonly length: 0.08;
    }];
    readonly noise: 0.02;
    readonly defaultVolume: 0.11;
}, {
    readonly name: "skip-next";
    readonly label: "Skip next";
    readonly category: "media";
    readonly description: "Playback advances to the next item.";
    readonly duration: 0.29;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.075;
        readonly gain: 0.58;
    }, {
        readonly at: 0.07;
        readonly semitone: 4;
        readonly length: 0.085;
    }, {
        readonly at: 0.145;
        readonly semitone: 12;
        readonly length: 0.105;
        readonly gain: 0.78;
    }];
    readonly panFrom: -0.35;
    readonly panTo: 0.55;
    readonly defaultVolume: 0.16;
}, {
    readonly name: "skip-previous";
    readonly label: "Skip previous";
    readonly category: "media";
    readonly description: "Playback returns to the previous item.";
    readonly duration: 0.29;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 12;
        readonly length: 0.075;
        readonly gain: 0.78;
    }, {
        readonly at: 0.07;
        readonly semitone: 4;
        readonly length: 0.085;
    }, {
        readonly at: 0.145;
        readonly semitone: 0;
        readonly length: 0.105;
        readonly gain: 0.58;
    }];
    readonly panFrom: 0.55;
    readonly panTo: -0.35;
    readonly defaultVolume: 0.16;
}, {
    readonly name: "connect";
    readonly label: "Connect";
    readonly category: "system";
    readonly description: "A device, service, or live session becomes available.";
    readonly duration: 0.62;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.22;
    }, {
        readonly at: 0.18;
        readonly semitone: 5;
        readonly length: 0.23;
    }, {
        readonly at: 0.37;
        readonly semitone: 12;
        readonly length: 0.18;
        readonly gain: 0.55;
    }];
    readonly defaultVolume: 0.2;
}, {
    readonly name: "disconnect";
    readonly label: "Disconnect";
    readonly category: "system";
    readonly description: "A device, service, or live session goes offline.";
    readonly duration: 0.58;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 12;
        readonly length: 0.21;
    }, {
        readonly at: 0.18;
        readonly semitone: 5;
        readonly length: 0.22;
    }, {
        readonly at: 0.34;
        readonly semitone: 0;
        readonly length: 0.18;
        readonly gain: 0.6;
    }];
    readonly noise: 0.06;
    readonly defaultVolume: 0.19;
}, {
    readonly name: "lock";
    readonly label: "Lock";
    readonly category: "system";
    readonly description: "Access closes or a protected state engages.";
    readonly duration: 0.34;
    readonly baseMidi: 55;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 4;
        readonly length: 0.14;
        readonly glide: -4;
    }, {
        readonly at: 0.11;
        readonly semitone: 0;
        readonly length: 0.17;
        readonly gain: 0.7;
    }];
    readonly transient: 0.55;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "unlock";
    readonly label: "Unlock";
    readonly category: "system";
    readonly description: "Access opens or a protected state disengages.";
    readonly duration: 0.45;
    readonly baseMidi: 62;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.1;
    }, {
        readonly at: 0.095;
        readonly semitone: 5;
        readonly length: 0.14;
    }, {
        readonly at: 0.21;
        readonly semitone: 12;
        readonly length: 0.18;
        readonly glide: 2;
    }];
    readonly transient: 0.3;
    readonly defaultVolume: 0.2;
}, {
    readonly name: "wake";
    readonly label: "Wake";
    readonly category: "system";
    readonly description: "A device or dormant interface becomes active.";
    readonly duration: 0.46;
    readonly baseMidi: 61;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.31;
        readonly glide: 9;
    }, {
        readonly at: 0.24;
        readonly semitone: 7;
        readonly length: 0.16;
        readonly gain: 0.45;
    }];
    readonly noise: 0.06;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "sleep";
    readonly label: "Sleep";
    readonly category: "system";
    readonly description: "A device or interface enters a dormant state.";
    readonly duration: 0.48;
    readonly baseMidi: 61;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 7;
        readonly length: 0.26;
        readonly glide: -7;
    }, {
        readonly at: 0.21;
        readonly semitone: -2;
        readonly length: 0.2;
        readonly gain: 0.5;
    }];
    readonly noise: 0.08;
    readonly defaultVolume: 0.15;
}, {
    readonly name: "reward";
    readonly label: "Reward";
    readonly category: "reward";
    readonly description: "The user receives a small unit of value.";
    readonly duration: 0.64;
    readonly baseMidi: 76;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.22;
    }, {
        readonly at: 0.1;
        readonly semitone: 12;
        readonly length: 0.24;
    }, {
        readonly at: 0.26;
        readonly semitone: 7;
        readonly length: 0.29;
    }];
    readonly transient: 0.35;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "level-up";
    readonly label: "Level up";
    readonly category: "reward";
    readonly description: "Capability, rank, or progression increases.";
    readonly duration: 0.92;
    readonly baseMidi: 64;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.24;
    }, {
        readonly at: 0.17;
        readonly semitone: 4;
        readonly length: 0.25;
    }, {
        readonly at: 0.34;
        readonly semitone: 7;
        readonly length: 0.26;
    }, {
        readonly at: 0.51;
        readonly semitone: 12;
        readonly length: 0.32;
    }];
    readonly defaultVolume: 0.25;
}, {
    readonly name: "achievement";
    readonly label: "Achievement";
    readonly category: "reward";
    readonly description: "A rare milestone deserves a fuller celebration.";
    readonly duration: 1.16;
    readonly baseMidi: 62;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.34;
    }, {
        readonly at: 0.16;
        readonly semitone: 7;
        readonly length: 0.34;
    }, {
        readonly at: 0.34;
        readonly semitone: 12;
        readonly length: 0.38;
    }, {
        readonly at: 0.56;
        readonly semitone: 16;
        readonly length: 0.42;
    }, {
        readonly at: 0.73;
        readonly semitone: 19;
        readonly length: 0.38;
    }];
    readonly defaultVolume: 0.26;
}, {
    readonly name: "streak";
    readonly label: "Streak";
    readonly category: "reward";
    readonly description: "Repeated participation extends an active streak.";
    readonly duration: 0.72;
    readonly baseMidi: 69;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.17;
    }, {
        readonly at: 0.14;
        readonly semitone: 2;
        readonly length: 0.18;
    }, {
        readonly at: 0.28;
        readonly semitone: 4;
        readonly length: 0.19;
    }, {
        readonly at: 0.43;
        readonly semitone: 7;
        readonly length: 0.21;
    }];
    readonly defaultVolume: 0.21;
}, {
    readonly name: "badge";
    readonly label: "Badge";
    readonly category: "reward";
    readonly description: "A collectible distinction is awarded.";
    readonly duration: 0.8;
    readonly baseMidi: 71;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.19;
    }, {
        readonly at: 0.14;
        readonly semitone: 9;
        readonly length: 0.23;
    }, {
        readonly at: 0.33;
        readonly semitone: 16;
        readonly length: 0.35;
    }];
    readonly transient: 0.2;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "bonus";
    readonly label: "Bonus";
    readonly category: "reward";
    readonly description: "An unexpected extra reward is revealed.";
    readonly duration: 0.86;
    readonly baseMidi: 66;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.18;
    }, {
        readonly at: 0.12;
        readonly semitone: 4;
        readonly length: 0.19;
    }, {
        readonly at: 0.25;
        readonly semitone: 9;
        readonly length: 0.23;
    }, {
        readonly at: 0.43;
        readonly semitone: 16;
        readonly length: 0.34;
    }];
    readonly transient: 0.3;
    readonly defaultVolume: 0.24;
}, {
    readonly name: "add-to-cart";
    readonly label: "Add to cart";
    readonly category: "commerce";
    readonly description: "An item enters a cart or pending order.";
    readonly duration: 0.49;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -2;
        readonly length: 0.1;
        readonly gain: 0.52;
    }, {
        readonly at: 0.105;
        readonly semitone: 7;
        readonly length: 0.18;
    }, {
        readonly at: 0.26;
        readonly semitone: 2;
        readonly length: 0.17;
        readonly gain: 0.58;
    }];
    readonly transient: 0.28;
    readonly defaultVolume: 0.19;
}, {
    readonly name: "remove-from-cart";
    readonly label: "Remove from cart";
    readonly category: "commerce";
    readonly description: "An item leaves a cart or pending order.";
    readonly duration: 0.45;
    readonly baseMidi: 70;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 10;
        readonly length: 0.1;
        readonly gain: 0.55;
    }, {
        readonly at: 0.1;
        readonly semitone: 3;
        readonly length: 0.14;
    }, {
        readonly at: 0.22;
        readonly semitone: -2;
        readonly length: 0.16;
        readonly gain: 0.64;
    }];
    readonly transient: 0.22;
    readonly defaultVolume: 0.17;
}, {
    readonly name: "checkout";
    readonly label: "Checkout";
    readonly category: "commerce";
    readonly description: "A cart advances into the payment flow.";
    readonly duration: 0.66;
    readonly baseMidi: 65;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.22;
    }, {
        readonly at: 0.18;
        readonly semitone: 5;
        readonly length: 0.23;
    }, {
        readonly at: 0.35;
        readonly semitone: 9;
        readonly length: 0.24;
    }];
    readonly defaultVolume: 0.2;
}, {
    readonly name: "purchase";
    readonly label: "Purchase";
    readonly category: "commerce";
    readonly description: "A paid transaction or value exchange completes.";
    readonly duration: 0.76;
    readonly baseMidi: 69;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: -5;
        readonly length: 0.12;
    }, {
        readonly at: 0.11;
        readonly semitone: 0;
        readonly length: 0.24;
    }, {
        readonly at: 0.28;
        readonly semitone: 7;
        readonly length: 0.32;
    }];
    readonly noise: 0.12;
    readonly transient: 0.55;
    readonly defaultVolume: 0.22;
}, {
    readonly name: "coupon";
    readonly label: "Coupon";
    readonly category: "commerce";
    readonly description: "A discount or promotional code is accepted.";
    readonly duration: 0.52;
    readonly baseMidi: 72;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 0;
        readonly length: 0.16;
    }, {
        readonly at: 0.13;
        readonly semitone: 4;
        readonly length: 0.18;
    }, {
        readonly at: 0.26;
        readonly semitone: 9;
        readonly length: 0.21;
    }];
    readonly transient: 0.16;
    readonly defaultVolume: 0.18;
}, {
    readonly name: "refund";
    readonly label: "Refund";
    readonly category: "commerce";
    readonly description: "Value returns after a completed transaction.";
    readonly duration: 0.7;
    readonly baseMidi: 67;
    readonly notes: readonly [{
        readonly at: 0;
        readonly semitone: 7;
        readonly length: 0.24;
    }, {
        readonly at: 0.19;
        readonly semitone: 2;
        readonly length: 0.25;
    }, {
        readonly at: 0.39;
        readonly semitone: 0;
        readonly length: 0.23;
        readonly gain: 0.65;
    }];
    readonly panFrom: 0.35;
    readonly panTo: -0.2;
    readonly defaultVolume: 0.2;
}];
type CueName = (typeof CUES)[number]['name'];
type PlaybackMode = 'one-shot' | 'loop';
interface PackDefinition {
    name: string;
    label: string;
    description: string;
    bestFor: string;
    color: string;
    waveform: 'sine' | 'triangle' | 'square' | 'saw';
    pitch: number;
    duration: number;
    attack: number;
    decay: number;
    noise: number;
    transient: number;
    brightness: number;
    echo: number;
    bitDepth: number;
    harmonics: readonly [number, number][];
    fmRatio?: number;
    fmDepth?: number;
    elasticity?: number;
    paper?: number;
    brush?: number;
    wood?: number;
    chime?: number;
}
declare const PACKS: readonly [{
    readonly name: "minimal";
    readonly label: "Minimal";
    readonly description: "Dry, precise, almost invisible.";
    readonly bestFor: "Productivity, SaaS, system UI";
    readonly color: "#e84d2a";
    readonly waveform: "sine";
    readonly pitch: 1;
    readonly duration: 0.78;
    readonly attack: 0.004;
    readonly decay: 2.3;
    readonly noise: 0.05;
    readonly transient: 0.15;
    readonly brightness: 0.78;
    readonly echo: 0;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2, 0.08]];
}, {
    readonly name: "soft";
    readonly label: "Soft";
    readonly description: "Rounded felt, warm and reassuring.";
    readonly bestFor: "Mobile, wellness, friendly SaaS";
    readonly color: "#d47b83";
    readonly waveform: "triangle";
    readonly pitch: 0.9;
    readonly duration: 1.08;
    readonly attack: 0.012;
    readonly decay: 1.65;
    readonly noise: 0.08;
    readonly transient: 0.08;
    readonly brightness: 0.46;
    readonly echo: 0.04;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2, 0.14], [3, 0.04]];
}, {
    readonly name: "glass";
    readonly label: "Glass";
    readonly description: "Bright, crystalline, and premium.";
    readonly bestFor: "Media, finance, luxury products";
    readonly color: "#4c8ca5";
    readonly waveform: "sine";
    readonly pitch: 1.22;
    readonly duration: 1.22;
    readonly attack: 0.003;
    readonly decay: 1.32;
    readonly noise: 0.025;
    readonly transient: 0.12;
    readonly brightness: 0.95;
    readonly echo: 0.09;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2.72, 0.28], [4.19, 0.11], [6.8, 0.05]];
}, {
    readonly name: "arcade";
    readonly label: "Arcade";
    readonly description: "Chunky pixels and cheerful voltage.";
    readonly bestFor: "Games, streaks, gamified learning";
    readonly color: "#7257d9";
    readonly waveform: "square";
    readonly pitch: 1.08;
    readonly duration: 0.86;
    readonly attack: 0.002;
    readonly decay: 1.1;
    readonly noise: 0.035;
    readonly transient: 0.2;
    readonly brightness: 0.72;
    readonly echo: 0.025;
    readonly bitDepth: 8;
    readonly harmonics: readonly [[1, 1], [2, 0.08]];
}, {
    readonly name: "mechanical";
    readonly label: "Mechanical";
    readonly description: "Switches, relays, and firm detents.";
    readonly bestFor: "Devtools, hardware, industrial UI";
    readonly color: "#68736f";
    readonly waveform: "triangle";
    readonly pitch: 0.74;
    readonly duration: 0.72;
    readonly attack: 0.001;
    readonly decay: 2.8;
    readonly noise: 0.24;
    readonly transient: 0.72;
    readonly brightness: 0.58;
    readonly echo: 0.015;
    readonly bitDepth: 12;
    readonly harmonics: readonly [[1, 1], [1.5, 0.13], [2.1, 0.08]];
}, {
    readonly name: "organic";
    readonly label: "Organic";
    readonly description: "Wood, water, breath, and small stones.";
    readonly bestFor: "Education, kids, calm games";
    readonly color: "#718b4e";
    readonly waveform: "sine";
    readonly pitch: 0.94;
    readonly duration: 1.12;
    readonly attack: 0.008;
    readonly decay: 1.85;
    readonly noise: 0.18;
    readonly transient: 0.28;
    readonly brightness: 0.4;
    readonly echo: 0.055;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [1.48, 0.18], [2.02, 0.09], [3.05, 0.035]];
}, {
    readonly name: "dreamy";
    readonly label: "Dreamy";
    readonly description: "Airy blooms, soft light, and slow sparkle.";
    readonly bestFor: "Creative tools, wellness, ambient apps";
    readonly color: "#a36cad";
    readonly waveform: "sine";
    readonly pitch: 1.05;
    readonly duration: 1.18;
    readonly attack: 0.02;
    readonly decay: 1.42;
    readonly noise: 0.045;
    readonly transient: 0.045;
    readonly brightness: 0.56;
    readonly echo: 0.13;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2, 0.12], [3.01, 0.07], [5.02, 0.025]];
}, {
    readonly name: "scifi";
    readonly label: "Sci-fi";
    readonly description: "Clean holographic pings with a restrained digital shimmer.";
    readonly bestFor: "AI tools, spatial UI, futuristic games";
    readonly color: "#20a29d";
    readonly waveform: "sine";
    readonly pitch: 1.1;
    readonly duration: 0.84;
    readonly attack: 0.0025;
    readonly decay: 2.05;
    readonly noise: 0.025;
    readonly transient: 0.16;
    readonly brightness: 0.82;
    readonly echo: 0.035;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2.01, 0.11], [3.98, 0.025]];
    readonly fmRatio: 2.01;
    readonly fmDepth: 0.42;
}, {
    readonly name: "rubber";
    readonly label: "Rubber";
    readonly description: "Tactile elastic taps with a quick, friendly rebound.";
    readonly bestFor: "Kids, playful mobile, casual games";
    readonly color: "#d99a24";
    readonly waveform: "triangle";
    readonly pitch: 0.86;
    readonly duration: 0.88;
    readonly attack: 0.0035;
    readonly decay: 2.2;
    readonly noise: 0.018;
    readonly transient: 0.22;
    readonly brightness: 0.5;
    readonly echo: 0.012;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [1.5, 0.075], [2.02, 0.04]];
    readonly elasticity: 1.15;
}, {
    readonly name: "cinematic";
    readonly label: "Cinematic";
    readonly description: "Deep impacts, polished tails, and quiet scale.";
    readonly bestFor: "Premium media, games, dramatic moments";
    readonly color: "#3f5873";
    readonly waveform: "sine";
    readonly pitch: 0.7;
    readonly duration: 1.28;
    readonly attack: 0.008;
    readonly decay: 1.78;
    readonly noise: 0.12;
    readonly transient: 0.55;
    readonly brightness: 0.38;
    readonly echo: 0.11;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [0.5, 0.22], [2, 0.1], [3, 0.035]];
}, {
    readonly name: "studio";
    readonly label: "Studio";
    readonly description: "Tactile editing precision with warm cinematic restraint.";
    readonly bestFor: "Film, audio, and AI creative tools";
    readonly color: "#6261a8";
    readonly waveform: "triangle";
    readonly pitch: 0.86;
    readonly duration: 0.82;
    readonly attack: 0.004;
    readonly decay: 2.15;
    readonly noise: 0.09;
    readonly transient: 0.24;
    readonly brightness: 0.48;
    readonly echo: 0.025;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2, 0.11], [3, 0.035]];
}, {
    readonly name: "zen";
    readonly label: "Zen";
    readonly description: "Pure tones, dry wood, and brief washi detail.";
    readonly bestFor: "Mindfulness, reading, writing, calm productivity";
    readonly color: "#7d8f77";
    readonly waveform: "sine";
    readonly pitch: 0.94;
    readonly duration: 0.82;
    readonly attack: 0.003;
    readonly decay: 2.7;
    readonly noise: 0;
    readonly transient: 0.025;
    readonly brightness: 0.52;
    readonly echo: 0;
    readonly bitDepth: 16;
    readonly harmonics: readonly [[1, 1], [2.01, 0.035]];
    readonly paper: 0.12;
    readonly brush: 0.065;
    readonly wood: 0.16;
    readonly chime: 0.09;
}];
type PackName = (typeof PACKS)[number]['name'];
declare const cueNames: CueName[];
declare const packNames: PackName[];
declare function getCue(name: CueName): CueDefinition;
declare function getPlaybackMode(name: CueName): PlaybackMode;
declare function getPack(name: PackName): PackDefinition;

interface PlayOptions {
    volume?: number;
    loop?: boolean;
    playbackRate?: number;
    retrigger?: 'restart' | 'overlap' | 'ignore';
    cooldownMs?: number;
}
interface UISFXOptions {
    pack?: PackName;
    volume?: number;
    enabled?: boolean;
    maxVoices?: number;
    cooldownMs?: number;
    preferences?: UISFXPreferences;
    context?: AudioContext;
}
interface UISFXPreferenceStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}
interface UISFXPreferences {
    key?: string;
    storage?: UISFXPreferenceStorage;
}
interface PlayingSFX {
    stop: () => void;
    ended: Promise<void>;
}
interface PreloadOptions {
    signal?: AbortSignal;
}
interface UISFXPlayer {
    unlock: () => Promise<boolean>;
    play: (cue: CueName, options?: PlayOptions) => PlayingSFX | null;
    preload: (cues?: readonly CueName[], options?: PreloadOptions) => Promise<void>;
    setPack: (pack: PackName) => void;
    getPack: () => PackName;
    setVolume: (volume: number) => void;
    getVolume: () => number;
    setEnabled: (enabled: boolean) => void;
    isEnabled: () => boolean;
    stopAll: () => void;
    destroy: () => Promise<void>;
}
declare function createUISFX(options?: UISFXOptions): UISFXPlayer;
declare function soundUrl(pack: PackName, cue: CueName, format?: 'mp3' | 'ogg'): string;

interface BindOptions extends UISFXOptions {
    player?: UISFXPlayer;
}
interface UISFXBinding {
    player: UISFXPlayer;
    unbind: () => void;
}
declare function bindUISFX(root?: Document | HTMLElement, options?: BindOptions): UISFXBinding;

interface RenderNote extends PatternNote {
    frequency: number;
    endFrequency: number;
}
interface SoundRecipe {
    cue: CueName;
    pack: PackName;
    duration: number;
    notes: RenderNote[];
    waveform: 'sine' | 'triangle' | 'square' | 'saw';
    harmonics: readonly [number, number][];
    attack: number;
    decay: number;
    noise: number;
    transient: number;
    brightness: number;
    echo: number;
    bitDepth: number;
    panFrom: number;
    panTo: number;
    loop: boolean;
    defaultVolume: number;
    fmRatio: number;
    fmDepth: number;
    elasticity: number;
    paper: number;
    brush: number;
    wood: number;
    chime: number;
}
declare function createRecipe(packName: PackName, cueName: CueName): SoundRecipe;

interface RenderedSound {
    sampleRate: number;
    duration: number;
    left: Float32Array;
    right: Float32Array;
    peak: number;
}
declare function renderRecipe(recipe: SoundRecipe, sampleRate?: number): RenderedSound;

export { type BindOptions, CATEGORIES, CUES, type CategoryName, type CueDefinition, type CueName, PACKS, type PackDefinition, type PackName, type PlayOptions, type PlaybackMode, type PlayingSFX, type PreloadOptions, type RenderedSound, type SoundRecipe, type UISFXBinding, type UISFXOptions, type UISFXPlayer, type UISFXPreferenceStorage, type UISFXPreferences, bindUISFX, createRecipe, createUISFX, cueNames, getCue, getPack, getPlaybackMode, packNames, renderRecipe, soundUrl };
