const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

function _onPopoverVisibleChanged(popover) {
    let context = popover.relative_to.get_style_context();
    if (popover.visible)
        context.add_class('has-open-popup');
    else
        context.remove_class('has-open-popup');
}

const RoomRow = new Lang.Class({
    Name: 'RoomRow',

    _init: function(room) {
        this._createWidget(room.icon);

        let app = Gio.Application.get_default();
        this.widget.room = room;
        this.widget.account = room.account;

        this._popover = null;

        this._eventBox.connect('button-release-event',
                            Lang.bind(this, this._onButtonRelease));
        this.widget.connect('key-press-event',
                            Lang.bind(this, this._onKeyPress));

        room.connect('notify::channel', Lang.bind(this,
            function() {
                if (!room.channel)
                    return;
                room.channel.connect('message-received',
                                     Lang.bind(this, this._updatePending));
                room.channel.connect('pending-message-removed',
                                     Lang.bind(this, this._updatePending));
            }));
        room.bind_property('display-name', this._roomLabel, 'label',
                           GObject.BindingFlags.SYNC_CREATE);

        this._updatePending();
    },

    selected: function() {
        if (!this.widget.room.channel)
            this._updatePending();
    },

    _updatePending: function() {
        let room = this.widget.room;

        let pending;
        let numPendingHighlights;

        if (room.channel) {
            pending = room.channel.dup_pending_messages();
            if (room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
                numPendingHighlights = pending.filter(function(m) {
                    return room.should_highlight_message(m);
                }).length;
            else
                numPendingHighlights = pending.length;
        } else {
            pending = [];
            numPendingHighlights = 0;
        }

        this._counter.label = numPendingHighlights.toString();
        this._counter.opacity = numPendingHighlights > 0 ? 1. : 0.;

        let context = this.widget.get_style_context();
        if (pending.length == 0)
            context.add_class('inactive');
        else
            context.remove_class('inactive');
    },

    _onButtonRelease: function(w, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_SECONDARY)
            return Gdk.EVENT_PROPAGATE;

        this._showPopover();

        return Gdk.EVENT_STOP;
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();
        let [, mods] = event.get_state();
        if (keyval != Gdk.KEY_Menu &&
            !(keyval == Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;

        this._showPopover();

        return Gdk.EVENT_STOP;
    },

    _showPopover: function() {
        if (!this._popover) {
            let room = this.widget.room;
            let menu = new Gio.Menu();
            menu.append(room.type == Tp.HandleType.ROOM ? _("Leave chatroom")
                                                        : _("End conversation"),
                        'app.leave-room(("%s", ""))'.format(room.id));

            this._popover = Gtk.Popover.new_from_model(this.widget, menu);
            this._popover.connect('notify::visible', _onPopoverVisibleChanged);
            this._popover.position = Gtk.PositionType.BOTTOM;
        }
        this._popover.show();
    },

    _createWidget: function(gicon) {
        this.widget = new Gtk.ListBoxRow({ margin_bottom: 4,
                                           focus_on_click: false });

        this._eventBox = new Gtk.EventBox();
        this.widget.add(this._eventBox);

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_start: 8, margin_end: 8,
                                margin_top: 2, margin_bottom: 2, spacing: 6 });
        this._eventBox.add(box);

        if (gicon) {
            let icon = new Gtk.Image({ gicon: gicon,
                                       icon_size: Gtk.IconSize.MENU,
                                       valign: Gtk.Align.BASELINE });
            box.add(icon);
        }

        this._roomLabel = new Gtk.Label({ hexpand: true,
                                          ellipsize: Pango.EllipsizeMode.END,
                                          halign: Gtk.Align.START,
                                          valign: Gtk.Align.BASELINE });
        box.add(this._roomLabel);

        let frame = new Gtk.AspectFrame({ obey_child: false,
                                          shadow_type: Gtk.ShadowType.NONE });
        box.add(frame);

        this._counter = new Gtk.Label({ width_chars: 2 });
        this._counter.get_style_context().add_class('pending-messages-count');
        frame.add(this._counter);

        this.widget.show_all();
    }
});

const RoomListHeader = new Lang.Class({
    Name: 'RoomListHeader',
    Extends: Gtk.MenuButton,
    CssName: 'row',
    Template: 'resource:///org/gnome/Polari/room-list-header.ui',
    InternalChildren: ['label',
                       'iconStack',
                       'popoverStatus',
                       'popoverTitle',
                       'popoverReconnect',
                       'popoverRemove',
                       'popoverProperties',
                       'spinner'],

    _init: function(params) {
        this._account = params.account;
        delete params.account;

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._app = Gio.Application.get_default();

        this.parent(params);

        this.popover.connect('notify::visible', _onPopoverVisibleChanged);

        let target = new GLib.Variant('o', this._account.get_object_path());
        this._popoverReconnect.action_target = target;
        this._popoverRemove.action_target = target;
        this._popoverProperties.action_target = target;

        let displayNameChangedId =
            this._account.connect('notify::display-name',
                                  Lang.bind(this, this._onDisplayNameChanged));
        this._onDisplayNameChanged();

        let connectionStatusChangedId =
            this._account.connect('notify::connection-status',
                                  Lang.bind(this, this._onConnectionStatusChanged));
        this._onConnectionStatusChanged();

        this.connect('destroy', Lang.bind(this, function() {
            this._account.disconnect(displayNameChangedId);
            this._account.disconnect(connectionStatusChangedId);
        }));
    },

    _onDisplayNameChanged: function() {
        this._label.label = this._account.display_name;

        let parent;
        do
          parent = this.get_parent();
        while (parent && !(parent instanceof Gtk.ListBox));

        if (parent)
          parent.invalidate_sort();

        let accessibleName = _("Connection %s has an error").format(this._account.display_name);
        this.get_accessible().set_name(accessibleName);
    },

    /* hack: Handle primary and secondary button interchangeably */
    vfunc_button_press_event: function(event) {
        if (event.button == Gdk.BUTTON_SECONDARY)
            event.button = Gdk.BUTTON_PRIMARY;
        return this.parent(event);
    },

    vfunc_button_release_event: function(event) {
        if (event.button == Gdk.BUTTON_SECONDARY)
            event.button = Gdk.BUTTON_PRIMARY;
        return this.parent(event);
    },

    _onConnectionStatusChanged: function() {
        let status = this._account.connection_status;
        let reason = this._account.connection_status_reason;
        let isError = (status == Tp.ConnectionStatus.DISCONNECTED &&
                       reason != Tp.ConnectionStatusReason.REQUESTED);
        let child = 'none';
        if (status == Tp.ConnectionStatus.CONNECTING) {
            if (this._networkMonitor.network_available)
                child = 'connecting';
        } else if (isError) {
            child = 'error';
        }
        this._iconStack.visible_child_name = child;
        this._spinner.active = (child == 'connecting');

        this._popoverTitle.use_markup = isError;
        this._popoverStatus.use_markup = !isError;

        if (!isError) {
            let styleContext = this._popoverStatus.get_style_context();
            styleContext.add_class('dim-label');

            let params = this._account.dup_parameters_vardict().deep_unpack();
            let server = params['server'].deep_unpack();
            let accountName = this._account.display_name;

            /* Translators: This is an account name followed by a
               server address, e.g. "GNOME (irc.gnome.org)" */
            let fullTitle = _("%s (%s)").format(accountName, server);
            this._popoverTitle.label = (accountName == server) ? accountName : fullTitle;
            this._popoverStatus.label = '<sup>' + this._getStatusLabel() + '</sup>';
        } else {
            let styleContext = this._popoverStatus.get_style_context();
            styleContext.remove_class('dim-label');

            this._popoverTitle.label = '<b>' + _("Connection Problem") + '</b>';
            this._popoverStatus.label = this._getErrorLabel();
        }
    },

    _getStatusLabel: function() {
        switch (this._account.connection_status) {
            case Tp.ConnectionStatus.CONNECTED:
                return _("Connected");
            case Tp.ConnectionStatus.CONNECTING:
                return _("Connecting...");
            case Tp.ConnectionStatus.DISCONNECTED:
                return _("Offline");
            default:
                return _("Unknown");
        }
    },

    _getErrorLabel: function() {
        switch (this._account.connection_error) {

            case Tp.error_get_dbus_name(Tp.Error.CERT_REVOKED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_INSECURE):
            case Tp.error_get_dbus_name(Tp.Error.CERT_LIMIT_EXCEEDED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_INVALID):
            case Tp.error_get_dbus_name(Tp.Error.ENCRYPTION_ERROR):
            case Tp.error_get_dbus_name(Tp.Error.CERT_NOT_PROVIDED):
            case Tp.error_get_dbus_name(Tp.Error.ENCRYPTION_NOT_AVAILABLE):
            case Tp.error_get_dbus_name(Tp.Error.CERT_UNTRUSTED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_EXPIRED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_NOT_ACTIVATED):
            case Tp.error_get_dbus_name(Tp.Error.CERT_HOSTNAME_MISMATCH):
            case Tp.error_get_dbus_name(Tp.Error.CERT_FINGERPRINT_MISMATCH):
            case Tp.error_get_dbus_name(Tp.Error.CERT_SELF_SIGNED):
                return _("Could not connect to %s in a safe way.").format(this._account.display_name);

            case Tp.error_get_dbus_name(Tp.Error.AUTHENTICATION_FAILED):
                return _("Could not connect to %s. Authentication failed.").format(this._account.display_name);

            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_FAILED):
            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_LOST):
            case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REPLACED):
            case Tp.error_get_dbus_name(Tp.Error.SERVICE_BUSY):
                return _("Could not connect to %s. The server is busy.").format(this._account.display_name);

            default:
                return _("Could not connect to %s.").format(this._account.display_name);
        }
    },
});

const RoomList = new Lang.Class({
    Name: 'RoomList',

    _init: function() {
        this.widget = new Gtk.ListBox({ hexpand: false });
        this.widget.get_style_context().add_class('sidebar');

        this.widget.set_selection_mode(Gtk.SelectionMode.BROWSE);
        this.widget.set_header_func(Lang.bind(this, this._updateHeader));
        this.widget.set_sort_func(Lang.bind(this, this._sort));

        this._placeholders = {};
        this._roomRows = {};
        this._selectedRows = 0;
        this._selectionMode = false;

        this.widget.connect('row-selected',
                            Lang.bind(this, this._onRowSelected));

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('account-manager-prepared', Lang.bind(this,
            function(mon, am) {
                let accounts = this._accountsMonitor.dupAccounts();
                for (let i = 0; i < accounts.length; i++)
                    this._accountAdded(mon, accounts[i]);

                am.connect('account-enabled', Lang.bind(this,
                    function(am, account) {
                        this._updatePlaceholderVisibility(account);
                    }));
                am.connect('account-disabled', Lang.bind(this,
                    function(am, account) {
                        this._updatePlaceholderVisibility(account);
                    }));
            }));
        this._accountsMonitor.connect('account-added',
                                      Lang.bind(this, this._accountAdded));
        this._accountsMonitor.connect('account-removed',
                                      Lang.bind(this, this._accountRemoved));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));

        let app = Gio.Application.get_default();
        this._leaveAction = app.lookup_action('leave-room');
        this._leaveAction.connect('activate',
                                  Lang.bind(this, this._onLeaveActivated));

        let action;
        action = app.lookup_action('next-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.DirectionType.DOWN);
            }));
        action = app.lookup_action('previous-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.DirectionType.UP);
            }));
        action = app.lookup_action('first-room');
        action.connect('activate', Lang.bind(this,
            function() {
                let row = this.widget.get_row_at_index(0);
                if (row)
                    this.widget.select_row(row);
            }));
        action = app.lookup_action('last-room');
        action.connect('activate', Lang.bind(this,
            function() {
                let nRows = this._roomManager.roomCount;
                let row = this.widget.get_row_at_index(nRows - 1);
                if (row)
                    this.widget.select_row(row);
            }));
        action = app.lookup_action('nth-room');
        action.connect('activate', Lang.bind(this,
            function(action, param) {
                let n = param.get_int32();
                if (n > this._roomManager.roomCount)
                    return;
                this.widget.select_row(this.widget.get_row_at_index(n - 1));
            }));
    },

    _onLeaveActivated: function(action, param) {
        let [id, ] = param.deep_unpack();
        let row = this._roomRows[id].widget;

        this._moveSelectionFromRow(row);
        row.hide();
    },

    _moveSelection: function(direction) {
        let current = this.widget.get_selected_row();
        if (!current)
            return;
        let inc = direction == Gtk.DirectionType.UP ? -1 : 1;
        let index = current.get_index();
        let row;
        do {
            index += inc;
            row = this.widget.get_row_at_index(index);
        } while (row && !row.room);
        if (row)
            this.widget.select_row(row);
    },

    _moveSelectionFromRow: function(row) {
        if (this._roomManager.roomCount == 0)
            return;

        let activeRoom = this._roomManager.getActiveRoom();
        let current = this._roomRows[activeRoom.id].widget;

        if (current != row)
            return;

        let selected = this.widget.get_selected_row();
        let newActive = null;

        this.widget.select_row(row);
        this._moveSelection(row.get_index() == 0 ? Gtk.DirectionType.DOWN
                                                 : Gtk.DirectionType.UP);

        let newSelected = this.widget.get_selected_row();
        if (newSelected != row)
            newActive = newSelected.room;
        this._roomManager.setActiveRoom(newActive);

        if (selected != row)
            this.widget.select_row(selected);
    },

    _accountAdded: function(am, account) {
        if (this._placeholders[account])
            return;

        let placeholder = new Gtk.ListBoxRow({ selectable: false,
                                               activatable: false });
        placeholder.account = account;

        this._placeholders[account] = placeholder;
        this.widget.add(placeholder);

        placeholder.connect('notify::visible', Lang.bind(this,
            function() {
                this.widget.invalidate_sort();
            }));

        this._updatePlaceholderVisibility(account);
    },

    _accountRemoved: function(am, account) {
        let placeholder = this._placeholders[account];

        if (!placeholder)
            return;

        delete this._placeholders[account];
        placeholder.destroy();
    },

    _roomAdded: function(roomManager, room) {
        let roomRow = new RoomRow(room);
        this.widget.add(roomRow.widget);
        this._roomRows[room.id] = roomRow;

        roomRow.widget.connect('destroy', Lang.bind(this,
            function(w) {
                delete this._roomRows[w.room.id];
            }));
        this._placeholders[room.account].hide();
    },

    _roomRemoved: function(roomManager, room) {
        let roomRow = this._roomRows[room.id];
        if (!roomRow)
            return;

        this._moveSelectionFromRow(roomRow.widget);
        roomRow.widget.destroy();
        delete this._roomRows[room.id];
        this._updatePlaceholderVisibility(room.account);
    },

    _updatePlaceholderVisibility: function(account) {
        if (!account.enabled) {
            this._placeholders[account].hide();
            return;
        }

        let ids = Object.keys(this._roomRows);
        let hasRooms = ids.some(Lang.bind(this,
            function(id) {
                return this._roomRows[id].widget.account == account;
            }));
        this._placeholders[account].visible = !hasRooms;
    },

    _activeRoomChanged: function(roomManager, room) {
        if (!room)
            return;
        let roomRow = this._roomRows[room.id];
        if (!roomRow)
            return;

        let row = roomRow.widget;
        row.can_focus = false;
        this.widget.select_row(row);
        row.can_focus = true;
    },

    _onRowSelected: function(w, row) {
        this._roomManager.setActiveRoom(row ? row.room : null);
        if (row)
            this._roomRows[row.room.id].selected();
    },

    _updateHeader: function(row, before) {
        let getAccount = function(row) {
            return row ? row.account : null;
        };
        let beforeAccount = getAccount(before);
        let account = getAccount(row);

        if (beforeAccount == account) {
            row.set_header(null);
            return;
        }

        if (row.get_header())
            return;

        let roomListHeader = new RoomListHeader({ account: account });
        row.set_header(roomListHeader);
    },

    _sort: function(row1, row2) {
        let account1 = row1.account;
        let account2 = row2.account;

        let hasRooms1 = !this._placeholders[account1].visible;
        let hasRooms2 = !this._placeholders[account2].visible;

        if (hasRooms1 != hasRooms2)
            return hasRooms1 ? -1 : 1;

        if (account1 != account2)
            return account1.display_name.localeCompare(account2.display_name);

        let room1 = row1.room;
        let room2 = row2.room;

        if (!room1)
            return -1;

        if (!room2)
            return 1;

        if (room1.type != room2.type)
            return room1.type == Tp.HandleType.ROOM ? -1 : 1;

        return room1.display_name.localeCompare(room2.display_name);
    }
});
