import QtQuick.Layouts

Item {
    anchors.fill: parent

    Column{
        width: parent.width
        height: parent.height
        spacing: 10

		Rectangle{
			id: scanningItem
			height: 50
			width: 350
			visible: service.controllers.length === 0
			color: theme.background2
			radius: theme.radius

			BusyIndicator {
				id: scanningIndicator
				height: 30
				anchors.verticalCenter: parent.verticalCenter
				width: parent.height
				Material.accent: "#88FFFFFF"
				running: scanningItem.visible
			}  

			Column{
				width: childrenRect.width
				anchors.left: scanningIndicator.right
				anchors.verticalCenter: parent.verticalCenter

				Text{
					color: "White"
					text: "Searching network for Yeelight Devices..." 
					font.pixelSize: 14
					font.family: theme.secondaryfont
				}
				Text{
					color: "White"
					text: "This may take several minutes..." 
					font.pixelSize: 14
					font.family: theme.secondaryfont
				}

			}
		}    
    
         Pane {
                width: 352
                height: 196
                padding: 8

                background: Rectangle {
                    color: theme.background2
                    radius: 8
                }

                ColumnLayout {
                    spacing: 4
                    anchors.fill: parent

                     Text{
				        color: "White"
				        text: "Manually Specify IP Address" 
				        font.family: theme.primaryfont
                        font.weight: Font.Bold
                        font.pixelSize: 16
                    }

                    TextField {

                        Layout.preferredWidth: 334
			        	id: discoverIP
			        	color: theme.secondarytextcolor
			        	font.family: theme.secondaryfont

			        	validator: RegularExpressionValidator {
			        	    regularExpression:  /^((?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.){0,3}(?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])$/
			        	}

                        background: Rectangle {
                            color: theme.background3
                            radius: 4
                        }
			        }

                    Text{
				        color: "White"
				        text: "Device Model" 
				        font.family: theme.primaryfont
                        font.pixelSize: 12
                    }

                    RowLayout {
                        Layout.preferredWidth: 334

                        SComboBox {
                            Layout.preferredWidth: 200
                            Layout.preferredHeight : 44
                            id: deviceModelCombo

                            model: ListModel {
                                
                                ListElement { text: "Other" }
                                ListElement { text: "Monitor Lightbar Pro" }
                                ListElement { text: "Cube Matrix" }
                                ListElement { text: "Cube Panel" }
                                ListElement { text: "Cube Spot" }
                                ListElement { text: "Beam RGBIC Lightbar" }
                                ListElement { text: "Obsid RGBIC Light Strip" }
                            }
                        }

                        SButton{
                            Layout.preferredWidth : 124
                            Layout.preferredHeight : 32
                            Layout.alignment: Qt.AlignRight
                            color: hovered ? Qt.darker(theme.background4, 1.5) : theme.background4
                            label.font.pixelSize: 16
                            label.text: "Check IP"

                            onClicked : {
                                discovery.checkForcedIP(discoverIP.text, deviceModelCombo.currentText)
                            }
                        }
                    }

                    SButton{
                        Layout.alignment: Qt.AlignRight
                        Layout.preferredHeight : 32
                        Layout.preferredWidth : 124
                        color: hovered ? Qt.darker("#531B1B", 1.5) : "#531B1B"
                        label.font.pixelSize: 16
                        label.text: "Clear IP Cache"

                        onClicked : {
                            cacheBurnBox.visible = true
                        }
                    }

                }
            }

        Repeater{
            model: service.controllers          

            delegate: Pane {
            id: root
            width: 352 // set Width
            height: contentHeight + padding * 2// dynamic height based on content
            padding: 12

            background: Rectangle {
                color: theme.background2
                radius: 8
            }
            property var device: model.modelData.obj

            property bool isExpanded: false // Use bool, int, real, etc over var for better performance

            ColumnLayout{
                width: parent.width
                spacing: 4

                Item{
                    width: parent.width
                    height: 20

                    Text{
                        id: deviceName
                        color: theme.primarytextcolor
                        text: root.device.name
                        font.pixelSize: 16
                        font.family: theme.primaryfont
                        font.weight: Font.Bold
                        verticalAlignment: Text.AlignVCenter
                    }

                    SIconButton{
                        id: expandButton
                        width: 24
                        height: 24
                        iconSize: height
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter

                        icon.source: "qrc:/icons/Resources/Icons/Icons_Onboarding_Icon.svg"

                      onClicked: {
                          root.isExpanded = !root.isExpanded

                       }
                    }
                }

				Text{
                    color: theme.secondarytextcolor
                    text: "IP Address: " + root.device.ip ?? "Unknown"
                }

                Text{
                    color: theme.secondarytextcolor
                    text: `Id: ${root.device.id} | Model: ${root.device.model}`
                }

                Text{
                    visible: root.isExpanded
                    color: theme.secondarytextcolor
                    text: `Uses Background Zone: ${root.device.supportsBackgroundRGB  ? "True" : "False"}`
                }

                Text{
                    visible: root.isExpanded
                    color: theme.secondarytextcolor
                    text: `Supports Individual Control: ${root.device.supportsPERLED ? "True" : "False"}`
                }

				Text{
                    visible: root.isExpanded
                    color: theme.secondarytextcolor
                    text: `Supports Segment Control: ${root.device.supportsSegments  ? "True" : "False"}`
                }
            }
            }
        }
    }

    //I'll burn this down once I get a better idea of how to do it.
    //For now it'll serve its purpose.
    Rectangle{
    id: cacheBurnBox
    height: 200
	width: 520
    radius: 8
    color: theme.background2
    visible: false

        Text{
            topPadding: 16
            anchors.horizontalCenter: parent.horizontalCenter

	    	color: "White"
	    	text: "Are you sure you want to clear the cache?" 
	    	font.pixelSize: 24
	    	font.family: theme.primaryfont
            wrapMode: Text.Wrap
	    }

        SButton{
            width: 132
            x: 122
            y: 92

            color: hovered ? Qt.darker(theme.background4, 1.5) : theme.background4
            label.font.pixelSize: 24
            label.text: "Go Back"

            onClicked : {
                cacheBurnBox.visible = false
            }
        }

        SButton{
            width: 132
            x: 278
            y: 92

            color: hovered ? Qt.darker("#531B1B", 1.5) : "#531B1B"
            label.font.pixelSize: 24
            label.text: "I'm Sure"

            onClicked : {
                discovery.purgeIPCache();
                cacheBurnBox.visible = false
            }
        }
    }
}